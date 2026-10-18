import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
  err,
  mindlogError,
  ok,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import {
  MemoryEngine,
  VectorCache,
  memoryCommitHandler,
  memoryForgetHandler,
} from '@mindlog/memory';
import { FakeModels } from '@mindlog/models-client';
import { startSingleNode } from '@mindlog/multiraft';
import type { RangeCall, RangeRouter, RangeTarget } from '@mindlog/services';
import { MemoryService } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  StateMachine,
  inSpan,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

/**
 * One range holding all memory, served by a `MemoryService`. With `remote` this
 * node holds no replica: calls are forwarded to a stand-in node that does.
 */
export async function memoryRange(
  options: {
    remote?: boolean;
    refuseFirst?: boolean;
    clusterVersion?: number;
    /** Like StoreRouter: `ranges()` names the ranges without their local targets. */
    bareRanges?: boolean;
  } = {},
) {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [memoryCommitHandler, memoryForgetHandler, jobLeaseHandler, jobCompleteHandler])
    handlers.register(h);
  const store = new MemoryStore();
  const events = new InMemoryEventBus({ logger, metrics });
  const span = wholeKeyspace(1n);
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events,
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor: span,
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const target: RangeTarget = {
    rangeId: 1n,
    proposer: replica,
    readBarrier: replica,
    reader: new SpanReader(store, span),
    state: store,
    descriptor: () => span,
    owns: () => true,
    covers: (key) => inSpan(span, key),
  };
  const random = new SeededRandom(1n);
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, random),
  );
  const models = new FakeModels();
  const vectors = new VectorCache({ state: store, maxScopes: 8 });
  vectors.attach(events);
  const engine = new MemoryEngine({
    models,
    stamper,
    ids: new UlidGenerator(clock, random),
    clock,
    metrics,
    logger,
    tracer: new OtelTracer(),
    vectors,
    ranges: () => ({ rangeId: 1n, proposer: replica, reader: target.reader }),
  });
  const forwarded: RangeCall[] = [];
  const holder: { service?: MemoryService } = {};
  const local = options.remote !== true;
  const router: RangeRouter = {
    place: () => Promise.resolve(ok([])),
    locate: () =>
      Promise.resolve(ok(local ? { rangeId: 1n, local: target } : { rangeId: 1n, address: 'n2' })),
    refresh: (p) => Promise.resolve(ok(p)),
    forward: async (p, caller, call) => {
      forwarded.push(call);
      if (options.refuseFirst && forwarded.length === 1)
        return err(mindlogError('NOT_LEADER', 'moved'));
      const reply = await holder.service?.forwarded(p.rangeId, caller, call);
      return reply ? ok(reply) : err(mindlogError('UNAVAILABLE', 'no holder'));
    },
    ranges: () =>
      Promise.resolve(ok([options.bareRanges ? { rangeId: 1n } : { rangeId: 1n, local: target }])),
    local: () => (local ? target : undefined),
    any: () => target,
  };
  const deps = {
    engine,
    stamper,
    ...(options.clusterVersion !== undefined
      ? { clusterVersion: () => options.clusterVersion ?? 0 }
      : {}),
  };
  const service = new MemoryService({ ...deps, router });
  // The stand-in node holds the range.
  holder.service = new MemoryService({ ...deps, router: { ...router, local: () => target } });
  const caller = { tenant: 'acme', principal: 'agent:test' };
  return { service, forwarded, caller, models, clock, store };
}
