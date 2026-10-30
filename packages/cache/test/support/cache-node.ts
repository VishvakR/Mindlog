import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import type { SemanticCacheConfig } from '@mindlog/cache';
import { SemanticCache, cacheInvalidateHandler, cacheSetHandler } from '@mindlog/cache';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { FakeModels } from '@mindlog/models-client';
import { startSingleNode } from '@mindlog/multiraft';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

export const TENANT = 'acme';
export const scope = { tenant: TENANT, user: 'u1' };
export const call = { principal: 'agent:test' };

/** A one-voter range with the cache handlers and a SemanticCache over FakeModels. */
export async function cacheNode(config: Partial<SemanticCacheConfig> = {}) {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  // Every memory counts as live here; the memory engine's check is tested in @mindlog/memory.
  handlers.register(cacheSetHandler(() => Promise.resolve(true)));
  handlers.register(cacheInvalidateHandler);
  const store = new MemoryStore();
  const descriptor = wholeKeyspace(1n);
  const machine = await StateMachine.open({
    store,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor,
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
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, random),
  );
  const models = new FakeModels();
  const range = { proposer: replica, reader: new SpanReader(store, replica.descriptor) };
  const cache = new SemanticCache({
    models,
    stamper,
    ids: new UlidGenerator(clock, random),
    clock,
    metrics,
    tracer: new OtelTracer(),
    config,
  });
  return { clock, metrics, models, range, cache, stamper, replica };
}
