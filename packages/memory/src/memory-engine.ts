import type {
  Clock,
  Logger,
  MindlogError,
  MindlogErrorCode,
  Metrics,
  Result,
  Tracer,
} from '@mindlog/core';
import { ERROR_CODES, err, mindlogError, ok, packHlc } from '@mindlog/core';
import { normalizeName, walk } from '@mindlog/index-graph';
import type { LeasedJob, Worker } from '@mindlog/jobs';
import { jobPrefix } from '@mindlog/jobs';
import { MvccReader } from '@mindlog/storage';
import { fromBinary } from '@bufbuild/protobuf';
import { JobSchema, JobState } from '@mindlog/proto';
import type { Capability, Models } from '@mindlog/models-client';
import type { Command, CommandResult, JobSpec } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import type { EnrichPayload } from './ingest/assemble.js';
import { ENRICH, assemble, enrichJob } from './ingest/assemble.js';
import type { IngestDraft } from './ingest/draft.js';
import type { IngestConfig } from './ingest/ingest-stages.js';
import { ingestStages } from './ingest/ingest-stages.js';
import { runStages } from './pipeline/stage.js';
import { indexTimeKey, indexTimePrefix } from './keys.js';
import { MemoryReads } from './read/memory-reads.js';
import { pack } from './recall/pack.js';
import type { PprRunner } from './recall/ppr.js';
import { inlinePpr } from './recall/ppr.js';
import { emptyDraft } from './recall/recall-draft.js';
import { DEFAULT_RECIPE, RECIPES } from './recall/recipes.js';
import type { IndexSource, RecallConfig } from './recall/recall-stages.js';
import { recallStages } from './recall/recall-stages.js';
import { minTrust } from './ingest/text.js';
import { listConflicts } from './review.js';
import type {
  AsOf,
  CallContext,
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
import type { VectorCache } from './vector-cache.js';
import { hlcMs, toView } from './view.js';

export interface MemoryConfig extends IngestConfig, RecallConfig {
  /** Default token budget of recall's packed context. */
  readonly tokenBudget: number;
  /** Jobs a user scope may hold before async remember answers BUSY (PLAN 12.7, ADR-0017). */
  readonly maxQueuedJobs: number;
  /** Most memories one taint cascade may forget (PLAN 13.4). */
  readonly maxCascade: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxTextBytes: 32 * 1024,
  entityLabels: [
    'person',
    'organization',
    'place',
    'product',
    'project',
    // No 'preference' label: preferences are facts; as a label it tags verbs like "prefer".
    'date',
    'event',
  ],
  linkThreshold: 0.75,
  linkTopK: 5,
  retrieveK: 50,
  rerankK: 50,
  // PPR (PLAN 11.3, ADR-0011): HippoRAG's damping, linking_top_k and passage_node_weight.
  damping: 0.5,
  maxIterations: 30,
  tolerance: 1e-6,
  pprMaxNodes: 5000,
  pprMentionLimit: 50,
  pprEntitySeeds: 5,
  pprMemorySeedWeight: 0.05,
  themeMaxNodes: 2000,
  themeCount: 2,
  modelTimeoutMs: 2000,
  // ADR-0015.
  conflictThreshold: 0.8,
  duplicateThreshold: 0.9,
  conflictPolicy: 'quarantine_new',
  conflictCandidates: 5,
  trustedTools: [],
  trustedDomains: [],
  tokenBudget: 1000,
  maxQueuedJobs: 1000,
  maxCascade: 1000,
};

export interface MemoryEngineDeps {
  readonly models: Models;
  /** Whether calls for a capability currently reach the model service (`GuardedModels.available`). */
  readonly available?: (capability: Capability) => boolean;
  readonly stamper: CommandStamper;
  readonly ids: { next(): string };
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly vectors: VectorCache;
  /** Where PPR iterations run; inline by default, a worker pool in the server. */
  readonly ppr?: PprRunner;
  /** This node's replica of a range, for jobs (the enrich worker). */
  readonly ranges: (rangeId: bigint) => MemoryRange | undefined;
  readonly config?: Partial<MemoryConfig>;
}

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

  constructor(deps: MemoryEngineDeps) {
    this.#d = deps;
    this.#config = { ...DEFAULT_MEMORY_CONFIG, ...deps.config };
  }

  get config(): MemoryConfig {
    return this.#config;
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

  async #ingest(range: MemoryRange, input: RememberInput, available?: (c: Capability) => boolean) {
    const draft: IngestDraft = { input, text: '', passages: [], facts: [], embeddingModel: '' };
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
        },
      },
      context.requestId,
    );
    const committed = await this.#propose(range, command);
    if (!committed.ok) return committed;
    const outcome = committed.value.outcome;
    const ids = outcome.case === 'memory' ? outcome.value.ids : [];
    const views: MemoryView[] = [];
    for (const id of ids) {
      const record = await reads.record(id);
      if (record) views.push(toView(record));
    }
    return ok(views);
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

  /** Reads of the scope's main space, at `asOf` when given. */
  async #reads(range: MemoryRange, scope: MemoryScope, asOf?: AsOf): Promise<MemoryReads> {
    const at = asOf ? await this.#version(range, scope, asOf) : undefined;
    return new MemoryReads(range.reader, scope.tenant, scope.user, at);
  }

  /** The vector index for `reads`: the cached one when current, else built at its version. */
  #indexFor(reads: MemoryReads): IndexSource {
    const { tenant, user, at } = reads;
    if (at === undefined && typeof user === 'string')
      return () => this.#d.vectors.index(tenant, user);
    let built: ReturnType<IndexSource> | undefined;
    return () => (built ??= this.#d.vectors.indexOf(tenant, [{ root: user, at }]));
  }

  /** Queued and leased jobs of a user scope, counted up to the limit (dead ones stay for the dashboard). */
  async #queuedJobs(range: MemoryRange, scope: MemoryScope): Promise<number> {
    let n = 0;
    for await (const { value } of new MvccReader(range.reader).scan(
      jobPrefix(scope.tenant, scope.user),
    )) {
      if (fromBinary(JobSchema, value).state !== JobState.DEAD) n++;
      if (n >= this.#config.maxQueuedJobs) break;
    }
    return n;
  }

  /** PLAN 12.3: remember synchronously, asynchronously, or degraded when models are down. */
  remember(
    range: MemoryRange,
    input: RememberInput,
    context: CallContext,
  ): Promise<Result<RememberOutput, MindlogError>> {
    return this.#d.tracer.withSpan(
      'memory.remember',
      { 'mindlog.tenant': input.scope.tenant },
      async () => {
        // Async: store the raw passages now (model stages forced to their fallbacks), enrich in a job.
        const run = await this.#ingest(range, input, input.async ? () => false : undefined);
        if (!run.ok) return run;
        const { draft, degraded } = run.value;
        const enrich = input.async === true || MODEL_STAGES.some((s) => degraded.has(s));
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
                    ...(input.tags ? { tags: input.tags } : {}),
                  }),
                ],
              }
            : { ids },
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
        const reads = await this.#reads(range, input.scope, input.asOf);
        const draft = emptyDraft(
          input,
          RECIPES[recipe],
          reads.at === undefined ? undefined : hlcMs(reads.at),
        );
        const ports = {
          models: this.#d.models,
          index: this.#indexFor(reads),
          reads,
          clock: this.#d.clock,
          ppr: this.#d.ppr ?? inlinePpr,
        };
        const run = await runStages(
          recallStages(ports, this.#config, draft),
          draft,
          this.#context('recall'),
        );
        if (!run.ok) return run;
        const { ranked, route, lists, themes } = run.value.draft;
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
          items: ranked.slice(0, input.k ?? 10),
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
    asOf?: AsOf,
  ): Promise<Result<MemoryView | undefined, MindlogError>> {
    const record = await (await this.#reads(range, scope, asOf)).record(id);
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
    },
  ): Promise<Result<{ memories: MemoryView[]; next?: string }, MindlogError>> {
    const memories: MemoryView[] = [];
    let next: string | undefined;
    const reads = await this.#reads(range, scope, options.asOf);
    for await (const r of reads.records(options.after)) {
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
    input: { scope: MemoryScope; ids: readonly string[]; reason?: string; sourceRef?: string },
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(range, input.scope, context, {
      case: 'memoryForget',
      value: {
        user: input.scope.user,
        ids: [...input.ids],
        reason: input.reason ?? '',
        sourceRef: input.sourceRef ?? '',
        cascadeLimit: this.#config.maxCascade,
      },
    });
  }

  /** Proposes a body for a scope and returns the memory ids its apply reports. */
  async #write(
    range: MemoryRange,
    scope: MemoryScope,
    context: CallContext,
    body: Parameters<CommandStamper['stamp']>[2],
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    const command = this.#d.stamper.stamp(scope.tenant, context.principal, body, context.requestId);
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
    input: { scope: MemoryScope; ids: readonly string[]; trust: Trust; reason?: string },
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#write(range, input.scope, context, {
      case: 'memoryTrust',
      value: {
        user: input.scope.user,
        ids: [...input.ids],
        trust: input.trust,
        reason: input.reason ?? '',
      },
    });
  }

  async history(
    range: MemoryRange,
    scope: MemoryScope,
    id: string,
  ): Promise<Result<HistoryEntry[], MindlogError>> {
    const versions = await new MemoryReads(range.reader, scope.tenant, scope.user).history(id);
    return ok(
      versions.map((v) => ({
        version: String(v.version),
        atMs: hlcMs(v.version),
        memory: toView(v.record),
      })),
    );
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
