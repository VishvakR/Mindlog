import type { MindlogError, MindlogErrorCode, Result } from '@mindlog/core';
import { ERROR_CODES, err, mindlogError, ok, packHlc } from '@mindlog/core';
import { normalizeName, walk } from '@mindlog/index-graph';
import type { LeasedJob, Worker } from '@mindlog/jobs';
import { jobPrefix } from '@mindlog/jobs';
import { MvccReader } from '@mindlog/storage';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { create, fromBinary } from '@bufbuild/protobuf';
import { JobSchema, JobSpecSchema, JobState } from '@mindlog/proto';
import type { MemoryMaintainSchema } from '@mindlog/proto';
import type { Capability } from '@mindlog/models-client';
import type {
  Command,
  CommandResult,
  Job,
  JobSpec,
  MemoryRecord,
  ScopeLifecycle,
} from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import type { EnrichPayload } from './ingest/assemble.js';
import { ENRICH, assemble, enrichJob } from './ingest/assemble.js';
import type { IngestDraft } from './ingest/draft.js';
import { ingestStages } from './ingest/ingest-stages.js';
import { runStages } from './pipeline/stage.js';
import { indexTimeKey, indexTimePrefix, rootOf } from './keys.js';
import type { LifecycleJob } from './lifecycle.js';
import { LIFECYCLE_JOBS } from './lifecycle.js';
import { ColdReads } from './read/cold-reads.js';
import { RecallStats } from './recall/recall-stats.js';
import type { EngineCore } from './lifecycle-ops.js';
import { LifecycleOps } from './lifecycle-ops.js';
import { CubeOps } from './cube/cube-ops.js';
import type { RedactionKind } from './ingest/redact.js';
import { fromToolTrace } from './ingest/tool-trace.js';
import { SplitOps } from './split/split-ops.js';
import type { ScopeReads } from './read/memory-reads.js';
import { MemoryReads } from './read/memory-reads.js';
import type { MemoryConfig, MemoryEngineDeps } from './engine-config.js';
import { DEFAULT_MEMORY_CONFIG } from './engine-config.js';
import { pack } from './recall/pack.js';
import { inlinePpr } from './recall/ppr.js';
import { emptyDraft } from './recall/recall-draft.js';
import { DEFAULT_RECIPE, RECIPES } from './recall/recipes.js';
import type { IndexSource } from './recall/recall-stages.js';
import { recallStages } from './recall/recall-stages.js';
import { minTrust } from './ingest/text.js';
import type { MergePolicy } from '@mindlog/branching';
import { branchSources, branchView, diffBranch, openBranch, planBranchMerge } from './branches.js';
import { listConflicts } from './review.js';
import type {
  AsOf,
  BranchDiff,
  BranchView,
  CallContext,
  MergeResult,
  ConflictView,
  ResolveInput,
  Trust,
  GraphView,
  HistoryEntry,
  MemoryRange,
  MemoryScope,
  MemoryView,
  RecallInput,
  RecallOutput,
  RememberInput,
  RememberOutput,
} from './types.js';
import { hlcMs, toView } from './view.js';

const CODES = new Set(Object.keys(ERROR_CODES));
const known = (code: string): MindlogErrorCode =>
  CODES.has(code) ? (code as MindlogErrorCode) : 'INTERNAL';
const MODEL_STAGES = ['extract', 'embed'];
const encoder = new TextEncoder();

/**
 * The memory engine on one range (PLAN 12): runs the pipelines where the range
 * leads, proposes the results and reads the range's applied state. Routing to
 * that range is the caller's (`MemoryService`, ADR-0016).
 */
export class MemoryEngine {
  readonly #d: MemoryEngineDeps;
  readonly #config: MemoryConfig;
  readonly #cold: ColdReads | undefined;
  readonly #stats: RecallStats;
  readonly #ops: LifecycleOps;
  /** The scope's semantic split (ADR-0039). */
  readonly split: SplitOps;
  readonly #cubes: CubeOps;

  constructor(deps: MemoryEngineDeps) {
    this.#d = deps;
    this.#config = { ...DEFAULT_MEMORY_CONFIG, ...deps.config };
    this.#cold = deps.cold ? new ColdReads(deps.cold) : undefined;
    const core: EngineCore = {
      deps,
      config: this.#config,
      cold: this.#cold,
      write: (range, scope, context, body) => this.#write(range, scope, context, body),
      version: (range, scope, asOf) => this.#version(range, scope, asOf),
      remember: (range, input, context) => this.remember(range, input, context),
      lifecycleOn: () => this.#lifecycleOn(),
    };
    this.#ops = new LifecycleOps(core);
    this.#cubes = new CubeOps(core, this.#ops);
    this.split = new SplitOps(core, this.#ops);
    this.#stats = new RecallStats({
      flush: (p) => this.#ops.flushStats(p),
      maxIds: this.#config.maxPendingRecalls,
      onDropped: (n) => {
        deps.metrics
          .counter({
            name: 'mindlog_memory_recall_stats_dropped_total',
            help: 'Recalled ids not recorded because a scope had too many waiting',
          })
          .inc(n);
      },
    });
    if (this.#config.recallStatsMs > 0) this.#stats.start(this.#config.recallStatsMs);
  }

  get config(): MemoryConfig {
    return this.#config;
  }

  /** Whether the cold tier is configured. */
  get coldTier(): boolean {
    return this.#cold !== undefined;
  }

  #lifecycleOn(): boolean {
    return this.#d.lifecycle?.() ?? true;
  }

  /** Proposes the recalled ids waiting, now (tests and shutdown; normally every 2 s). */
  flushRecallStats(): Promise<void> {
    return this.#stats.flush();
  }

  /** Stops the recall-stats timer after proposing what waits. */
  close(): Promise<void> {
    return this.#stats.stop();
  }

  #context(pipeline: string, available = this.#d.available ?? (() => true)) {
    const { clock, metrics, tracer } = this.#d;
    return { pipeline, clock, metrics, tracer, available };
  }

  async #propose(
    range: MemoryRange,
    command: Command,
  ): Promise<Result<CommandResult, MindlogError>> {
    const proposed = await range.proposer.propose(command);
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case === 'error')
      return err(mindlogError(known(outcome.value.code), outcome.value.message));
    return ok(proposed.value.result);
  }

  async #ingest(
    range: MemoryRange,
    input: RememberInput,
    available?: (c: Capability) => boolean,
    redact: readonly RedactionKind[] = [],
  ) {
    const draft: IngestDraft = {
      input,
      redact,
      text: '',
      passages: [],
      facts: [],
      embeddingModel: '',
    };
    const reads = new MemoryReads(range.reader, input.scope.tenant, input.scope.user);
    const stages = ingestStages(this.#d.models, this.#d.vectors, reads, this.#config);
    return runStages(stages, draft, this.#context('ingest', available));
  }

  async #commit(
    range: MemoryRange,
    draft: IngestDraft,
    context: CallContext,
    extra: {
      ids?: readonly string[];
      derivedFrom?: readonly string[];
      enqueue?: JobSpec[];
      complete?: { id: string; attempt: number };
      reembed?: boolean;
    },
  ): Promise<Result<MemoryView[], MindlogError>> {
    const { scope } = draft.input;
    let n = 0;
    const nextId = () => extra.ids?.[n++] ?? this.#d.ids.next();
    let inherited: Trust = 'verified';
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user);
    for (const id of extra.derivedFrom ?? [])
      inherited = minTrust(inherited, ((await reads.record(id))?.trust ?? 'normal') as Trust);
    const { memories, edges, conflicts, supersede } = assemble(
      draft,
      context,
      nextId,
      extra.derivedFrom,
      inherited,
    );
    const command = this.#d.stamper.stamp(
      scope.tenant,
      context.principal,
      {
        case: 'memoryCommit',
        value: {
          user: scope.user,
          memories,
          edges,
          conflicts,
          supersede,
          enqueue: extra.enqueue ?? [],
          ...(extra.complete ? { complete: extra.complete } : {}),
          ...(draft.input.branch ? {} : this.#tick()),
          ...(extra.reembed ? { reembed: true } : {}),
        },
      },
      context.requestId,
    );
    if (draft.input.branch) command.branch = draft.input.branch;
    const committed = await this.#propose(range, command);
    if (!committed.ok) return committed;
    const outcome = committed.value.outcome;
    const ids = outcome.case === 'memory' ? outcome.value.ids : [];
    const written = new MemoryReads(
      range.reader,
      scope.tenant,
      rootOf(scope.user, draft.input.branch),
    );
    const views: MemoryView[] = [];
    for (const id of ids) {
      const record = await written.record(id);
      if (record) views.push(toView(record));
    }
    return ok(views);
  }

  /** The scope's consolidation tick for a main commit; apply keeps it only if none is scheduled. */
  #tick(): { tick?: JobSpec } {
    if (this.#config.tickDelayMs <= 0 || !this.#lifecycleOn()) return {};
    return {
      tick: create(JobSpecSchema, {
        id: `tick-${this.#d.ids.next()}`,
        kind: LIFECYCLE_JOBS.tick,
        runAtMs: this.#d.clock.now() + BigInt(this.#config.tickDelayMs),
      }),
    };
  }

  /**
   * The MVCC version of an `ASOF` (PLAN 13.3): a time is a version (ADR-0027);
   * a log index maps through the index-time table to the version of the last
   * memory command at or before it (0 before any).
   */
  async #version(range: MemoryRange, scope: MemoryScope, asOf: AsOf): Promise<bigint> {
    if ('timeMs' in asOf) return packHlc(BigInt(Math.floor(asOf.timeMs)), 0xffffn);
    const { tenant, user } = scope;
    for await (const { value } of new MvccReader(range.reader).scan(indexTimePrefix(tenant, user), {
      reverse: true,
      before: indexTimeKey(tenant, user, asOf.index + 1n),
      limit: 1,
    }))
      return new DataView(value.buffer, value.byteOffset, 8).getBigUint64(0);
    return 0n;
  }

  /** What a read sees: main (at `asOf` when given) or a branch over main at its fork (ADR-0013). */
  async #sources(
    range: MemoryRange,
    scope: MemoryScope,
    view: { asOf?: AsOf | undefined; branch?: string | undefined },
  ): Promise<Result<{ reads: ScopeReads; index: IndexSource }, MindlogError>> {
    if (view.branch) {
      if (view.asOf)
        return err(
          mindlogError('INVALID_ARGUMENT', 'ASOF reads main; it does not combine with a branch'),
        );
      const branch = await openBranch(range, scope, view.branch);
      if (!branch.ok) return branch;
      return ok(branchSources(range, scope, branch.value, this.#d.vectors));
    }
    const at = view.asOf ? await this.#version(range, scope, view.asOf) : undefined;
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user, at);
    return ok({ reads, index: this.#indexFor(reads) });
  }

  /** The vector index for `reads`: the cached one when current, else built at its version. */
  #indexFor(reads: MemoryReads): IndexSource {
    const { tenant, user, at } = reads;
    if (at === undefined && typeof user === 'string')
      return () => this.#d.vectors.index(tenant, user);
    let built: ReturnType<IndexSource> | undefined;
    return () => (built ??= this.#d.vectors.indexOf(tenant, [{ root: user, at }]));
  }

  /** Queued and leased enrich jobs of a user scope, counted up to the limit (dead ones stay for the dashboard). */
  async #queuedJobs(range: MemoryRange, scope: MemoryScope): Promise<number> {
    let n = 0;
    for await (const { value } of new MvccReader(range.reader).scan(
      jobPrefix(scope.tenant, scope.user),
    )) {
      const job = fromBinary(JobSchema, value);
      // Consolidation jobs are the scope's own background work, not callers' backlog.
      if (job.state !== JobState.DEAD && !job.kind.startsWith('consolidation.')) n++;
      if (n >= this.#config.maxQueuedJobs) break;
    }
    return n;
  }

  /** PLAN 12.3: remember synchronously, asynchronously, or degraded when models are down. */
  remember(
    range: MemoryRange,
    given: RememberInput,
    context: CallContext,
  ): Promise<Result<RememberOutput, MindlogError>> {
    const input = fromToolTrace(given);
    return this.#d.tracer.withSpan(
      'memory.remember',
      { 'mindlog.tenant': input.scope.tenant },
      async () => {
        if (input.branch && input.async)
          return err(
            mindlogError('INVALID_ARGUMENT', 'async remember is not available on a branch'),
          );
        // Async: store the raw passages now (model stages forced to their fallbacks), enrich in a job.
        const run = await this.#ingest(
          range,
          input,
          input.async ? () => false : undefined,
          context.redact,
        );
        if (!run.ok) return run;
        const { draft, degraded } = run.value;
        // Branch memories are not enriched: the job would write to main.
        const enrich =
          !input.branch && (input.async === true || MODEL_STAGES.some((s) => degraded.has(s)));
        if (
          input.async &&
          (await this.#queuedJobs(range, input.scope)) >= this.#config.maxQueuedJobs
        )
          return err(
            mindlogError('BUSY', 'too many enrichment jobs are queued for this scope; retry later'),
          );
        const jobId = enrich ? this.#d.ids.next() : undefined;
        const ids = draft.facts.map(() => this.#d.ids.next());
        const views = await this.#commit(
          range,
          draft,
          context,
          jobId
            ? {
                ids,
                enqueue: [
                  enrichJob(jobId, {
                    text: draft.text,
                    episodic: ids,
                    ...(input.scope.agent ? { agent: input.scope.agent } : {}),
                    ...(input.scope.session ? { session: input.scope.session } : {}),
                    ...(input.source ? { source: input.source } : {}),
                    // From the draft: stage 2 may have redacted them.
                    ...(draft.input.tags ? { tags: draft.input.tags } : {}),
                  }),
                ],
                ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
              }
            : { ids, ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}) },
        );
        if (!views.ok) return views;
        if (!input.async && degraded.size > 0)
          this.#d.metrics
            .counter({
              name: 'mindlog_memory_degraded_total',
              help: 'Degraded pipeline runs',
              labelNames: ['pipeline'],
            })
            .inc(1, { pipeline: 'ingest' });
        return ok({
          ids: views.value.map((v) => v.id),
          memories: views.value,
          ...(jobId ? { jobId } : {}),
          degraded: !input.async && degraded.size > 0,
        });
      },
    );
  }

  /** PLAN 12.4: parse, route, retrieve, fuse, filter, rerank, score, diversify and pack (ADR-0011). */
  recall(
    range: MemoryRange,
    input: RecallInput,
    _context: CallContext,
  ): Promise<Result<RecallOutput, MindlogError>> {
    return this.#d.tracer.withSpan(
      'memory.recall',
      { 'mindlog.tenant': input.scope.tenant },
      async () => {
        const recipe = input.recipe ?? DEFAULT_RECIPE;
        const sources = await this.#sources(range, input.scope, input);
        if (!sources.ok) return sources;
        const { reads, index } = sources.value;
        const draft = emptyDraft(
          input,
          RECIPES[recipe],
          reads.at === undefined ? undefined : hlcMs(reads.at),
        );
        const cold = this.#cold;
        const ports = {
          models: this.#d.models,
          index,
          reads,
          clock: this.#d.clock,
          ppr: this.#d.ppr ?? inlinePpr,
          ...(cold
            ? {
                coldText: async (stub: MemoryRecord) => {
                  const e = await cold.entry(stub);
                  if (!e.ok)
                    this.#d.logger.warn('cold memory unreadable', {
                      id: stub.id,
                      error: e.error.message,
                    });
                  return e.ok ? e.value.record.text : undefined;
                },
              }
            : {}),
        };
        const run = await runStages(
          recallStages(ports, this.#config, draft),
          draft,
          this.#context('recall'),
        );
        if (!run.ok) return run;
        const { ranked, route, lists, themes } = run.value.draft;
        const returned = ranked.slice(0, input.k ?? 10);
        // Recalls strengthen what they return (PLAN 13.7); reading the past or a branch does not.
        if (!input.asOf && !input.branch && this.#lifecycleOn())
          this.#stats.add(
            range,
            input.scope,
            returned.map((it) => it.memory.id),
            returned.filter((it) => it.memory.tier === 'cold').map((it) => it.memory.id),
          );
        const packed = pack(
          ranked.map((it) => ({
            id: it.memory.id,
            text: it.memory.text,
            kind: it.memory.kind,
            score: it.score,
          })),
          input.tokenBudget ?? this.#config.tokenBudget,
        );
        return ok({
          items: returned,
          context: packed.context,
          tokens: packed.tokens,
          budget: packed.budget,
          groups: packed.groups,
          dropped: packed.dropped,
          compressed: packed.compressed,
          recipe,
          route,
          degraded: run.value.degraded.size > 0,
          ...(input.explain ? { explain: { lists: Object.fromEntries(lists), themes } } : {}),
        });
      },
    );
  }

  async get(
    range: MemoryRange,
    scope: MemoryScope,
    id: string,
    view: { asOf?: AsOf | undefined; branch?: string | undefined } = {},
  ): Promise<Result<MemoryView | undefined, MindlogError>> {
    const sources = await this.#sources(range, scope, view);
    if (!sources.ok) return sources;
    const record = await sources.value.reads.record(id);
    return ok(record ? toView(record) : undefined);
  }

  async list(
    range: MemoryRange,
    scope: MemoryScope,
    options: {
      limit: number;
      after?: string | undefined;
      kind?: string;
      includeForgotten?: boolean;
      asOf?: AsOf | undefined;
      branch?: string | undefined;
    },
  ): Promise<Result<{ memories: MemoryView[]; next?: string }, MindlogError>> {
    const memories: MemoryView[] = [];
    let next: string | undefined;
    const sources = await this.#sources(range, scope, options);
    if (!sources.ok) return sources;
    for await (const r of sources.value.reads.records(options.after)) {
      if (r.expiredAt !== 0n && !options.includeForgotten) continue;
      if (options.kind && r.kind !== options.kind) continue;
      if (r.agent !== (scope.agent ?? r.agent) || r.session !== (scope.session ?? r.session))
        continue;
      if (memories.length === options.limit) {
        next = memories.at(-1)?.id;
        break;
      }
      memories.push(toView(r));
    }
    return ok(next ? { memories, next } : { memories });
  }

  /** Forgets memories, and with `sourceRef` everything from that source and derived from it (PLAN 13.4). */
  async forget(
    range: MemoryRange,
    input: {
      scope: MemoryScope;
      ids: readonly string[];
      reason?: string;
      sourceRef?: string;
      branch?: string;
    },
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(
      range,
      input.scope,
      context,
      {
        case: 'memoryForget',
        value: {
          user: input.scope.user,
          ids: [...input.ids],
          reason: input.reason ?? '',
          sourceRef: input.sourceRef ?? '',
          cascadeLimit: this.#config.maxCascade,
        },
      },
      input.branch,
    );
  }

  /** Proposes a body for a scope and returns the memory ids its apply reports. */
  async #write(
    range: MemoryRange,
    scope: MemoryScope,
    context: CallContext,
    body: Parameters<CommandStamper['stamp']>[2],
    branch?: string,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    const command = this.#d.stamper.stamp(scope.tenant, context.principal, body, context.requestId);
    if (branch) command.branch = branch;
    const done = await this.#propose(range, command);
    if (!done.ok) return done;
    const o = done.value.outcome;
    return ok(
      o.case === 'memory' ? { ids: [...o.value.ids], count: o.value.count } : { ids: [], count: 0 },
    );
  }

  /** A page of the scope's conflicts (ADR-0015). */
  async conflicts(
    range: MemoryRange,
    scope: MemoryScope,
    options: { all?: boolean; limit: number; after?: string | undefined },
  ): Promise<Result<{ conflicts: ConflictView[]; next?: string }, MindlogError>> {
    return listConflicts(new MemoryReads(range.reader, scope.tenant, scope.user), {
      all: options.all ?? false,
      limit: options.limit,
      after: options.after,
    });
  }

  /** Resolves an open conflict (`MEM.RESOLVE`); returns the memories it changed. */
  resolve(
    range: MemoryRange,
    input: ResolveInput,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(range, input.scope, context, {
      case: 'conflictResolve',
      value: {
        user: input.scope.user,
        id: input.id,
        keep: input.keep,
        validFrom: BigInt(Math.floor(input.validFromMs ?? 0)),
        nowMs: this.#d.clock.now(),
      },
    });
  }

  /** Sets the trust of memories (review of quarantined content, PLAN 13.4). */
  setTrust(
    range: MemoryRange,
    input: {
      scope: MemoryScope;
      ids: readonly string[];
      trust: Trust;
      reason?: string;
      branch?: string;
    },
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(
      range,
      input.scope,
      context,
      {
        case: 'memoryTrust',
        value: {
          user: input.scope.user,
          ids: [...input.ids],
          trust: input.trust,
          reason: input.reason ?? '',
        },
      },
      input.branch,
    );
  }

  /** Creates a branch of the scope that reads main as of now (ADR-0013). */
  createBranch(
    range: MemoryRange,
    scope: MemoryScope,
    name: string,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(range, scope, context, {
      case: 'branchCreate',
      value: { user: scope.user, name, maxWrites: this.#config.branchMaxWrites },
    });
  }

  async branches(
    range: MemoryRange,
    scope: MemoryScope,
  ): Promise<Result<BranchView[], MindlogError>> {
    const out: BranchView[] = [];
    for await (const b of new MemoryReads(range.reader, scope.tenant, scope.user).branches())
      out.push(branchView(b));
    return ok(out);
  }

  async diffBranch(
    range: MemoryRange,
    scope: MemoryScope,
    name: string,
  ): Promise<Result<BranchDiff, MindlogError>> {
    const branch = await openBranch(range, scope, name);
    return branch.ok ? ok(await diffBranch(range, scope, branch.value)) : branch;
  }

  /**
   * Merges a branch into main under a policy (ADR-0013). The plan is made
   * here and applied only if main has not moved since; if it has, it is made again.
   */
  async mergeBranch(
    range: MemoryRange,
    input: {
      scope: MemoryScope;
      name: string;
      policy: MergePolicy;
      dryRun?: boolean;
      /** NLI deadline for the merge's conflict check; background merges allow longer. */
      timeoutMs?: number;
    },
    context: CallContext,
  ): Promise<Result<MergeResult, MindlogError>> {
    for (let attempt = 0; ; attempt++) {
      const branch = await openBranch(range, input.scope, input.name);
      if (!branch.ok) return branch;
      const planned = await planBranchMerge(range, input.scope, branch.value, input.policy, {
        models: this.#d.models,
        vectors: this.#d.vectors,
        config: input.timeoutMs
          ? { ...this.#config, modelTimeoutMs: input.timeoutMs }
          : this.#config,
        ids: this.#d.ids,
        nowMs: Number(this.#d.clock.now()),
        principal: context.principal,
        fenceBranch: this.#lifecycleOn(),
      });
      if (!planned.ok) return planned;
      const { body, result } = planned.value;
      if (!body || input.dryRun) return ok(result);
      const done = await this.#write(range, input.scope, context, {
        case: 'branchMerge',
        value: body,
      });
      if (done.ok) return ok(result);
      if (done.error.code !== 'CONFLICT' || attempt >= 2) return done;
    }
  }

  dropBranch(
    range: MemoryRange,
    scope: MemoryScope,
    name: string,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(range, scope, context, {
      case: 'branchDrop',
      value: { user: scope.user, name },
    });
  }

  /**
   * A record's versions, newest first (PLAN 17.2 version history): one entry per
   * revision, from MVCC history within retention and the kept earlier
   * versions beyond it (ADR-0033).
   */
  async history(
    range: MemoryRange,
    scope: MemoryScope,
    id: string,
  ): Promise<Result<HistoryEntry[], MindlogError>> {
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user);
    // One entry per visible state: recall stats rewrite records without changing what they say.
    const stateOf = (r: MemoryRecord) =>
      `${String(r.version)}|${String(r.expiredAt)}|${r.tier}|${r.trust}|${String(r.pinned)}`;
    const byRevision = new Map<string, HistoryEntry>();
    const revisions = new Set<number>();
    for (const v of await reads.history(id)) {
      const key = stateOf(v.record);
      revisions.add(v.record.version);
      if (!byRevision.has(key))
        byRevision.set(key, {
          version: String(v.version),
          revision: v.record.version,
          atMs: hlcMs(v.version),
          memory: toView(v.record),
        });
    }
    for (const r of await reads.versions(id))
      if (!revisions.has(r.version))
        byRevision.set(stateOf(r), {
          version: '',
          revision: r.version,
          atMs: hlcMs(r.createdAt),
          memory: toView(r),
        });
    return ok([...byRevision.values()].sort((a, b) => b.revision - a.revision || b.atMs - a.atMs));
  }

  /** An entity (by name or `type:name` id), its 1–2 hop neighbourhood and the memories mentioning it. */
  async graph(
    range: MemoryRange,
    scope: MemoryScope,
    entity: string,
    depth: number,
  ): Promise<Result<GraphView, MindlogError>> {
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user);
    let id: string | undefined = (await reads.entity(entity)) ? entity : undefined;
    if (!id) {
      const norm = normalizeName(entity);
      let best = -1;
      for await (const e of reads.entities())
        if (e.id.endsWith(`:${norm}`) && e.entity.mentionCount > best) {
          id = e.id;
          best = e.entity.mentionCount;
        }
    }
    if (!id) return err(mindlogError('NOT_FOUND', `no entity ${entity}`));
    const walked = await walk(reads.graph(), [id], { depth, limit: 200 });
    const nodes = [];
    for (const n of walked.nodes) {
      const e = await reads.entity(n.id);
      nodes.push({
        id: n.id,
        name: e?.name ?? n.id,
        type: e?.type ?? '',
        depth: n.depth,
        mentions: e?.mentionCount ?? 0,
      });
    }
    return ok({
      nodes,
      edges: walked.edges,
      memories: await reads.mentions(id, 100),
      truncated: walked.truncated,
    });
  }

  /** Moves cold memories back to the hot tier (ADR-0033). */
  promote(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#ops.promote(range, scope, ids, context);
  }

  /** Proposes lifecycle changes of one scope (`MemoryMaintain`, ADR-0033). */
  maintain(
    range: MemoryRange,
    scope: MemoryScope,
    body: MessageInitShape<typeof MemoryMaintainSchema>,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#ops.maintain(range, scope, body, context);
  }

  /** Pins or unpins memories: pinned ones never go cold or are hard-forgotten (PLAN 13.7). */
  pin(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    pinned: boolean,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#ops.pin(range, scope, ids, pinned, context);
  }

  /** The scope's lifecycle state (ADR-0033); empty before its first commit. */
  lifecycle(range: MemoryRange, scope: MemoryScope): Promise<ScopeLifecycle> {
    return this.#ops.lifecycle(range, scope);
  }

  /** A page of the scope's jobs in id order, all states but done. */
  jobs(
    range: MemoryRange,
    scope: MemoryScope,
    options: { limit: number; state?: JobState; after?: string | undefined },
  ): Promise<{ jobs: Job[]; next?: string }> {
    return this.#ops.jobs(range, scope, options);
  }

  /** Enqueues consolidation workers now (`MEM.CONSOLIDATE`, ADR-0033). */
  consolidate(
    range: MemoryRange,
    scope: MemoryScope,
    kinds: readonly LifecycleJob[] | undefined,
    context: CallContext,
  ): Promise<Result<{ enqueued: string[] }, MindlogError>> {
    return this.#ops.consolidate(range, scope, kinds, context);
  }

  /** Drops semantic-cache entries of the scope (the cache janitor's expired ones, ADR-0012). */
  invalidateCache(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#ops.invalidateCache(range, scope, ids, context);
  }

  /** The scope as a `.mcube` (PLAN 13.11), at `asOf` or now. */
  /** The parts of the scope's `.mcube`, unpacked (ADR-0039). */
  exportParts(range: MemoryRange, scope: MemoryScope, asOf?: AsOf) {
    return this.#cubes.exportParts(range, scope, asOf);
  }

  /** The MVCC version (HLC) an `ASOF index` names on this scope's range. */
  versionAt(range: MemoryRange, scope: MemoryScope, asOf: AsOf): Promise<bigint> {
    return this.#version(range, scope, asOf);
  }

  exportCube(
    range: MemoryRange,
    scope: MemoryScope,
    asOf?: AsOf,
  ): Promise<Result<Uint8Array, MindlogError>> {
    return this.#cubes.exportCube(range, scope, asOf);
  }

  /** Imports a `.mcube` or COGX archive into the scope (PLAN 13.11). */
  importCube(
    range: MemoryRange,
    scope: MemoryScope,
    input: { bytes: Uint8Array; format: 'mcube' | 'cogx'; name: string },
    context: CallContext,
  ): Promise<Result<{ imported: number; skipped: number; ids: string[] }, MindlogError>> {
    return this.#cubes.importCube(range, scope, input, context);
  }

  /** The scope's vector index as recall sees it (dedup reads it). */
  vectorIndex(scope: MemoryScope) {
    return this.#d.vectors.index(scope.tenant, scope.user);
  }

  /** The `memory.enrich` worker (PLAN 12.2): derives facts from an episodic memory once models work. */
  enrichWorker(): Worker {
    return {
      kind: ENRICH,
      run: async (job: LeasedJob) => {
        const range = this.#d.ranges(job.rangeId);
        if (!range)
          return err(mindlogError('UNAVAILABLE', `range ${String(job.rangeId)} is not here`));
        const payload = JSON.parse(new TextDecoder().decode(job.job.payload)) as EnrichPayload;
        const input: RememberInput = {
          scope: {
            tenant: job.tenant,
            user: job.user,
            ...(payload.agent ? { agent: payload.agent } : {}),
            ...(payload.session ? { session: payload.session } : {}),
          },
          content: payload.text,
          ...(payload.source ? { source: payload.source as RememberInput['source'] & object } : {}),
          ...(payload.tags ? { tags: payload.tags } : {}),
        };
        const run = await this.#ingest(range, input);
        if (!run.ok) return run;
        if (MODEL_STAGES.some((s) => run.value.degraded.has(s)))
          return err(mindlogError('UNAVAILABLE', 'models are still unavailable'));
        const committed = await this.#commit(
          range,
          run.value.draft,
          {
            principal: 'system:enrich',
            requestId: encoder.encode(`enrich:${job.job.id}:${String(job.attempt)}`),
          },
          { derivedFrom: payload.episodic, complete: { id: job.job.id, attempt: job.attempt } },
        );
        return committed.ok ? ok({ completed: true }) : committed;
      },
    };
  }
}
