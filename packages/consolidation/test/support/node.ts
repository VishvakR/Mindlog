import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { MemoryBlobStore } from '@mindlog/blob';
import { cacheInvalidateHandler, cacheSetHandler } from '@mindlog/cache';
import type { ConsolidationConfig } from '@mindlog/consolidation';
import {
  DEFAULT_CONSOLIDATION_CONFIG,
  ModelBudget,
  consolidationWorkers,
} from '@mindlog/consolidation';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  JobRunner,
  WorkerRegistry,
  jobCompleteHandler,
  jobLeaseHandler,
  jobRangeHooks,
} from '@mindlog/jobs';
import type { MemoryConfig, MemoryRange } from '@mindlog/memory';
import {
  MemoryEngine,
  VectorCache,
  branchCreateHandler,
  branchDropHandler,
  branchMergeHandler,
  conflictResolveHandler,
  liveMemory,
  memoryCommitHandler,
  memoryForgetHandler,
  memoryMaintainHandler,
  memoryRecallStatsHandler,
  memoryTrustHandler,
} from '@mindlog/memory';
import type { Models } from '@mindlog/models-client';
import { FakeModels } from '@mindlog/models-client';
import { startSingleNode } from '@mindlog/multiraft';
import type { CommandStamper as Stamper } from '@mindlog/statemachine';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

export const START = 1_760_000_000_000n;
export const TENANT = 'acme';
export const DAY = 86_400_000n;
export const scope = (user = 'u1', extra: { agent?: string; session?: string } = {}) => ({
  tenant: TENANT,
  user,
  ...extra,
});
export const ctx = { principal: 'agent:test' };

/** A one-voter range with every memory handler, an engine and the consolidation workers. */
export async function lifecycleNode(
  options: {
    models?: Models;
    memory?: Partial<MemoryConfig>;
    consolidation?: Partial<ConsolidationConfig>;
    cold?: boolean;
  } = {},
) {
  const clock = new ManualClock(START);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [
    memoryCommitHandler,
    memoryForgetHandler,
    conflictResolveHandler,
    memoryTrustHandler,
    branchCreateHandler,
    branchMergeHandler,
    branchDropHandler,
    memoryMaintainHandler,
    memoryRecallStatsHandler,
    jobLeaseHandler,
    jobCompleteHandler,
    cacheSetHandler(liveMemory),
    cacheInvalidateHandler,
  ])
    handlers.register(h);
  const store = new MemoryStore();
  const events = new InMemoryEventBus({ logger, metrics });
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events,
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor: wholeKeyspace(1n),
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const random = new SeededRandom(7n);
  const ids = new UlidGenerator(clock, random);
  const stamper = new CommandStamper(new HybridLogicalClock(clock, { maxOffsetMs: 500n }), ids);
  const models = options.models ?? new FakeModels();
  const vectors = new VectorCache({ state: store, maxScopes: 16, metrics });
  vectors.attach(events);
  const range: MemoryRange = {
    rangeId: 1n,
    proposer: replica,
    reader: new SpanReader(store, replica.descriptor),
  };
  const blob = options.cold === false ? undefined : new MemoryBlobStore();
  const engine = new MemoryEngine({
    models,
    stamper,
    ids,
    clock,
    metrics,
    logger,
    tracer: new OtelTracer(),
    vectors,
    ranges: (id) => (id === 1n ? range : undefined),
    config: { recallStatsMs: 0, ...options.memory },
    ...(blob ? { cold: blob } : {}),
  });
  const config = { ...DEFAULT_CONSOLIDATION_CONFIG, ...options.consolidation };
  const workers = new WorkerRegistry();
  workers.register(engine.enrichWorker());
  for (const w of consolidationWorkers({
    engine,
    models,
    ranges: (id) => (id === 1n ? range : undefined),
    clock,
    ids,
    metrics,
    logger,
    tracer: new OtelTracer(),
    budget: new ModelBudget(config.modelSecondsPerHour, () => Number(clock.now())),
    config,
    ...(blob ? { cold: blob } : {}),
  }))
    workers.register(w);
  const runner = new JobRunner({
    rangeId: 1n,
    state: store,
    proposer: replica,
    stamper,
    active: () => true,
    clock,
    logger,
    metrics,
    workers,
    concurrency: 1,
  });
  /** Runs due jobs until none is left (at most `max` passes). */
  const drain = async (max = 50) => {
    let total = 0;
    for (let i = 0; i < max; i++) {
      const ran = await runner.runOnce();
      if (ran === 0) break;
      total += ran;
    }
    return total;
  };
  const remember = async (content: string, extra: Record<string, unknown> = {}) => {
    const r = await engine.remember(range, { scope: scope(), content, ...extra }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const propose = async (body: Parameters<Stamper['stamp']>[2]) => {
    const r = await replica.propose(stamper.stamp(TENANT, 'test', body));
    if (!r.ok) throw new Error(r.error.message);
    return r.value.result;
  };
  return {
    clock,
    store,
    engine,
    range,
    runner,
    drain,
    remember,
    propose,
    blob,
    logger,
    metrics,
    models,
  };
}
