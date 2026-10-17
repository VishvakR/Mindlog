import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { startSingleNode } from '@mindlog/multiraft';
import type { PdServiceDeps } from '@mindlog/pd';
import { PD_HANDLERS, PD_RANGE_ID, PdService } from '@mindlog/pd';
import { MemoryStore } from '@mindlog/storage';

/** A one-voter PD group over memory stores. */
export async function pdNode(startMs = 1_760_000_000_000n) {
  const clock = new ManualClock(startMs);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of PD_HANDLERS) handlers.register(h);
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
    rangeId: PD_RANGE_ID,
    descriptor: wholeKeyspace(PD_RANGE_ID),
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), PD_RANGE_ID),
    machine,
    clock,
    logger,
    metrics,
    rangeId: PD_RANGE_ID,
  });
  const hlc = new HybridLogicalClock(clock, { maxOffsetMs: 500n });
  const stamper = new CommandStamper(hlc, new UlidGenerator(clock, new SeededRandom(1n)));
  const service = (overrides: Partial<PdServiceDeps> = {}) =>
    new PdService({
      group: replica,
      reader: store,
      clock,
      stamper,
      hlc,
      logger,
      metrics,
      storeHeartbeatMs: 1000,
      deadAfterMs: 10_000,
      ...overrides,
    });
  return { clock, logger, metrics, store, machine, replica, hlc, service };
}
