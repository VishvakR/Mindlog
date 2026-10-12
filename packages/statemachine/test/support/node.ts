import { ManualClock, MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';
import type { LocalProposerOptions } from '@mindlog/statemachine';
import { ApplyHandlerRegistry, LocalLog, LocalProposer, StateMachine } from '@mindlog/statemachine';
import { counterHandler } from './counter-handler.js';

/** A single-node pipeline (log + state machine + proposer) over the given stores. */
export async function startNode(
  logStore: KvStore = new MemoryStore(),
  stateStore: KvStore = new MemoryStore(),
  options: LocalProposerOptions = {},
) {
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
  });
  const log = await LocalLog.open(logStore);
  const proposer = new LocalProposer({ log, machine, logger, metrics, options });
  return { logStore, stateStore, machine, log, proposer, logger, metrics };
}
