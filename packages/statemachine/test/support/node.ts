import { ManualClock, MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';
import { ApplyHandlerRegistry, StateMachine, wholeKeyspace } from '@mindlog/statemachine';
import { counterHandler } from './counter-handler.js';

/** A state machine with the counter handler over the given state store. */
export async function startNode(stateStore: KvStore = new MemoryStore()) {
  const handlers = new ApplyHandlerRegistry();
  handlers.register(counterHandler);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const events = new InMemoryEventBus({ logger, metrics });
  const machine = await StateMachine.open({
    store: stateStore,
    handlers,
    events,
    clock: new ManualClock(),
    logger,
    metrics,
    descriptor: wholeKeyspace(1n),
  });
  return { stateStore, machine, logger, metrics };
}
