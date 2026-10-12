import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Clock,
  Logger,
  Metrics,
  MindlogConfig,
  MindlogError,
  Result,
  Tracer,
} from '@mindlog/core';
import {
  HybridLogicalClock,
  SystemRandom,
  UlidGenerator,
  mindlogError,
  ok,
  err,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvWriteHandler,
} from '@mindlog/kv';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  LocalLog,
  LocalProposer,
  StateMachine,
  recover,
} from '@mindlog/statemachine';
import { LevelDbStore } from '@mindlog/storage';

/** Clock skew tolerated by the HLC (PLAN 8.4). */
const MAX_CLOCK_OFFSET_MS = 500n;

export interface CoreDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
  readonly tracer: Tracer;
}

/** Storage, log, state machine and the KV service, without any listener. */
export interface NodeCore {
  readonly dataDir: string;
  readonly machine: StateMachine;
  readonly proposer: LocalProposer;
  readonly stamper: CommandStamper;
  readonly stateStore: LevelDbStore;
  readonly service: KvService;
  /** Log entries replayed into state at startup (ADR-0005). */
  readonly replayed: number;
  /** Finishes pending proposals, checkpoints and closes both stores. */
  close(): Promise<void>;
}

/** Opens the log and state LevelDB instances (ADR-0005), closing the first if the second fails. */
async function openStores(dataDir: string) {
  await mkdir(dataDir, { recursive: true });
  const log = await LevelDbStore.open(join(dataDir, 'raftlog'));
  if (!log.ok) return log;
  const state = await LevelDbStore.open(join(dataDir, 'state'));
  if (!state.ok) {
    await log.value.close();
    return state;
  }
  return ok({ log: log.value, state: state.value });
}

/**
 * Opens a node's data directory and recovers it: the part shared by the
 * server and offline CLI commands such as `superuser upsert`.
 */
export async function openNodeCore(
  config: MindlogConfig,
  deps: CoreDeps,
): Promise<Result<NodeCore, MindlogError>> {
  const { logger, metrics, clock, tracer } = deps;
  const dataDir = resolve(config.node.dataDir);
  const stores = await openStores(dataDir);
  if (!stores.ok) {
    return err(
      mindlogError(stores.error.code, `cannot open ${dataDir}: ${stores.error.message}`, {
        cause: stores.error,
      }),
    );
  }
  const { log: logStore, state: stateStore } = stores.value;
  const registry = createKvRegistry();
  const handlers = new ApplyHandlerRegistry();
  for (const handler of [
    kvWriteHandler(registry),
    kvBatchHandler(registry),
    expireHandler,
    gcThresholdHandler,
  ]) {
    handlers.register(handler);
  }
  const machine = await StateMachine.open({
    store: stateStore,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
  });
  const log = await LocalLog.open(logStore);
  const replayed = await recover(log, machine);
  const proposer = new LocalProposer({
    log,
    machine,
    logger,
    metrics,
    tracer,
    options: { maxQueue: config.limits.maxPendingProposals },
  });
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: MAX_CLOCK_OFFSET_MS }),
    new UlidGenerator(clock, new SystemRandom()),
  );
  const service = new KvService({
    registry,
    store: stateStore,
    proposer,
    stamper,
    clock,
    authenticator: new StaticAuthenticator(config.auth.password),
    metrics,
    tracer,
    maxTransactionCommands: config.limits.maxTransactionCommands,
  });
  return ok({
    dataDir,
    machine,
    proposer,
    stamper,
    stateStore,
    service,
    replayed,
    async close() {
      await proposer.close();
      await proposer.checkpoint();
      await Promise.all([logStore.close(), stateStore.close()]);
    },
  });
}
