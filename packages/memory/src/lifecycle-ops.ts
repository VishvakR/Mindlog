import type { MessageInitShape } from '@bufbuild/protobuf';
import { create, fromBinary } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { jobKey, jobPrefix } from '@mindlog/jobs';
import type { CommandStamper } from '@mindlog/statemachine';
import type { Job, ScopeLifecycle, TierMove } from '@mindlog/proto';
import {
  JobSchema,
  JobState,
  MemoryMaintainSchema,
  ScopeLifecycleSchema,
  TierMoveSchema,
} from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { vectorBytes } from './ingest/assemble.js';
import { lifecycleKey } from './keys.js';
import type { LifecycleJob } from './lifecycle.js';
import { LIFECYCLE_JOBS } from './lifecycle.js';
import type { MemoryConfig, MemoryEngineDeps } from './engine-config.js';
import type { ColdReads } from './read/cold-reads.js';
import { MemoryReads } from './read/memory-reads.js';
import type { PendingStats } from './recall/recall-stats.js';
import type {
  AsOf,
  CallContext,
  MemoryRange,
  MemoryScope,
  RememberInput,
  RememberOutput,
} from './types.js';

/** What the lifecycle and cube operations use of the engine. */
export interface EngineCore {
  readonly deps: MemoryEngineDeps;
  readonly config: MemoryConfig;
  readonly cold: ColdReads | undefined;
  write(
    range: MemoryRange,
    scope: MemoryScope,
    context: CallContext,
    body: Parameters<CommandStamper['stamp']>[2],
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>>;
  version(range: MemoryRange, scope: MemoryScope, asOf: AsOf): Promise<bigint>;
  remember(
    range: MemoryRange,
    input: RememberInput,
    context: CallContext,
  ): Promise<Result<RememberOutput, MindlogError>>;
  lifecycleOn(): boolean;
}

const encoder = new TextEncoder();

/**
 * The memory lifecycle on one range (ADR-0033): recall stats, tier moves back
 * to hot, maintenance commands, pins, the scope's lifecycle state and jobs,
 * and on-demand consolidation.
 */
export class LifecycleOps {
  readonly #c: EngineCore;

  constructor(core: EngineCore) {
    this.#c = core;
  }

  /** Proposes one scope's recalled ids, then brings its recalled cold memories back hot. */
  async flushStats(p: PendingStats): Promise<void> {
    const context = { principal: 'system:recall' };
    const done = await this.#c.write(p.range, p.scope, context, {
      case: 'memoryRecallStats',
      value: { user: p.scope.user, ids: [...p.ids] },
    });
    if (!done.ok)
      this.#c.deps.logger.warn('recall stats not proposed', {
        tenant: p.scope.tenant,
        error: done.error.message,
      });
    if (p.cold.size > 0) {
      const promoted = await this.promote(p.range, p.scope, [...p.cold], context);
      if (!promoted.ok)
        this.#c.deps.logger.warn('cold memories not promoted', { error: promoted.error.message });
    }
  }

  /**
   * Moves cold memories back to the hot tier (ADR-0033): text and vector from
   * their segment, or a fresh vector when the scope's model changed since.
   */
  async promote(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    const cold = this.#c.cold;
    if (!cold) return err(mindlogError('UNAVAILABLE', 'no cold tier is configured'));
    const reads = new MemoryReads(range.reader, scope.tenant, scope.user);
    const model = (await this.lifecycle(range, scope)).embedModel;
    const moves: TierMove[] = [];
    for (const id of ids) {
      const stub = await reads.record(id);
      if (!stub || stub.tier !== 'cold' || stub.expiredAt !== 0n) continue;
      const e = await cold.entry(stub);
      if (!e.ok) return e;
      let { vector, modelId } = e.value;
      if (modelId !== model || vector.length === 0) {
        const fresh = await this.#c.deps.models.embed([e.value.record.text], 'passage', {
          timeoutMs: this.#c.config.modelTimeoutMs,
        });
        // Without models it comes back without a vector; the re-embed worker adds one later.
        vector = fresh.ok ? vectorBytes(fresh.value.vectors[0]) : new Uint8Array();
        modelId = fresh.ok ? fresh.value.modelId : '';
      }
      moves.push(
        create(TierMoveSchema, { id, tier: 'hot', text: e.value.record.text, vector, modelId }),
      );
    }
    // shortcut: the segment stays in the blob store after its memories come back hot;
    // add segment GC once cold data grows large.
    if (moves.length === 0) return ok({ ids: [], count: 0 });
    return this.maintain(range, scope, { tier: moves }, context);
  }

  /** Proposes lifecycle changes of one scope (`MemoryMaintain`, ADR-0033). */
  maintain(
    range: MemoryRange,
    scope: MemoryScope,
    body: MessageInitShape<typeof MemoryMaintainSchema>,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    if (!this.#c.lifecycleOn())
      return Promise.resolve(
        err(
          mindlogError('UNAVAILABLE', 'the cluster has not reached version 8 (memory lifecycle)'),
        ),
      );
    const value = create(MemoryMaintainSchema, body);
    value.user = scope.user;
    return this.#c.write(range, scope, context, { case: 'memoryMaintain', value });
  }

  /** Pins or unpins memories: pinned ones never go cold or are hard-forgotten (PLAN 13.7). */
  pin(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    pinned: boolean,
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.maintain(range, scope, { pin: ids.map((id) => ({ id, pinned })) }, context);
  }

  /** The scope's lifecycle state (ADR-0033); empty before its first commit. */
  async lifecycle(range: MemoryRange, scope: MemoryScope): Promise<ScopeLifecycle> {
    const bytes = await new MvccReader(range.reader).get(lifecycleKey(scope.tenant, scope.user));
    return bytes ? fromBinary(ScopeLifecycleSchema, bytes) : create(ScopeLifecycleSchema);
  }

  /** A page of the scope's jobs in id order, all states but done (done jobs are deleted). */
  async jobs(
    range: MemoryRange,
    scope: MemoryScope,
    options: { limit: number; state?: JobState; after?: string | undefined },
  ): Promise<{ jobs: Job[]; next?: string }> {
    const out: Job[] = [];
    const prefix = jobPrefix(scope.tenant, scope.user);
    const after = options.after ? jobKey(scope.tenant, scope.user, options.after) : undefined;
    for await (const { value } of new MvccReader(range.reader).scan(
      prefix,
      after ? { after } : {},
    )) {
      const job = fromBinary(JobSchema, value);
      if (options.state !== undefined && job.state !== options.state) continue;
      if (out.length === options.limit) return { jobs: out, next: out.at(-1)?.id ?? '' };
      out.push(job);
    }
    return { jobs: out };
  }

  /**
   * Enqueues consolidation workers now (`MEM.CONSOLIDATE`, ADR-0033): the
   * given kinds, or every worker but the tick; kinds with a job still
   * queued or leased are skipped.
   */
  async consolidate(
    range: MemoryRange,
    scope: MemoryScope,
    kinds: readonly LifecycleJob[] | undefined,
    context: CallContext,
  ): Promise<Result<{ enqueued: string[] }, MindlogError>> {
    const state = await this.lifecycle(range, scope);
    const wanted =
      kinds ??
      Object.values(LIFECYCLE_JOBS).filter(
        (k) => k !== LIFECYCLE_JOBS.tick && (k !== LIFECYCLE_JOBS.reembed || state.reembed),
      );
    const { jobs } = await this.jobs(range, scope, { limit: 200 });
    const running = new Set(jobs.filter((j) => j.state !== JobState.DEAD).map((j) => j.kind));
    const enqueued = wanted.filter((k) => !running.has(k));
    if (enqueued.length === 0) return ok({ enqueued });
    const done = await this.maintain(
      range,
      scope,
      {
        enqueue: enqueued.map((kind) => ({
          id: `${kind.replace('consolidation.', '')}-manual-${this.#c.deps.ids.next()}`,
          kind,
          payload: encoder.encode(JSON.stringify({ why: `requested by ${context.principal}` })),
        })),
      },
      context,
    );
    return done.ok ? ok({ enqueued }) : done;
  }

  /** Drops semantic-cache entries of the scope (the cache janitor's expired ones, ADR-0012). */
  invalidateCache(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    context: CallContext,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>> {
    return this.#c.write(range, scope, context, {
      case: 'cacheInvalidate',
      value: { user: scope.user, ids: [...ids] },
    });
  }
}
