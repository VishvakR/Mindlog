import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import {
  ClientRegistry,
  CommandTable,
  RespServer,
  createConnectionCommands,
  loadCommandSpecs,
} from '@mindlog/adapter-resp';
import type { Clock, Logger, Metrics, MindlogConfig, MindlogError, Result } from '@mindlog/core';
import {
  HybridLogicalClock,
  OtelTracer,
  PromMetrics,
  SystemClock,
  SystemRandom,
  UlidGenerator,
  createLogger,
  err,
  initTracing,
  ok,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  ExpiryJob,
  GcJob,
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
import { serverInfo } from './server-info.js';

/** Clock skew tolerated by the HLC (PLAN 8.4). */
const MAX_CLOCK_OFFSET_MS = 500n;

export interface NodeOptions {
  readonly logger?: Logger;
  readonly metrics?: Metrics;
  readonly clock?: Clock;
}

export interface RunningNode {
  readonly config: MindlogConfig;
  readonly resp: AddressInfo;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Log entries replayed into state at startup (ADR-0005). */
  readonly replayed: number;
  /** Stops accepting, finishes in-flight work, flushes state and closes the stores. */
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
 * Starts a single node (phase 1): durable local log, state machine, KV
 * service, RESP listener, and the replicated expiry and GC jobs. The only
 * place that knows every concrete adapter (CLAUDE.md §3.1).
 */
export async function startNode(
  config: MindlogConfig,
  options: NodeOptions = {},
): Promise<Result<RunningNode, MindlogError>> {
  const logger =
    options.logger ?? createLogger({ level: config.observability.logLevel, name: 'mindlog' });
  const metrics = options.metrics ?? new PromMetrics();
  const clock = options.clock ?? new SystemClock();
  const tracing = initTracing({
    serviceName: 'mindlog',
    endpoint: config.observability.tracing.endpoint,
    sampleRatio: config.observability.tracing.sampleRatio,
  });
  const dataDir = resolve(config.node.dataDir);
  const stores = await openStores(dataDir);
  if (!stores.ok) return stores;
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
  const events = new InMemoryEventBus({ logger, metrics });
  const machine = await StateMachine.open({
    store: stateStore,
    handlers,
    events,
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
    tracer: new OtelTracer(),
    maxTransactionCommands: config.limits.maxTransactionCommands,
  });

  const startedAtMs = clock.now();
  const context = {
    service,
    commands: new CommandTable(loadCommandSpecs()),
    clients: new ClientRegistry(),
    clock,
    logger,
    info: serverInfo(config, config.listen.resp.port, startedAtMs),
  };
  const resp = new RespServer({
    context,
    handlers: createConnectionCommands(),
    metrics,
    options: {
      host: config.listen.resp.host,
      port: config.listen.resp.port,
      maxClients: config.limits.maxClients,
      idleTimeoutMs: config.limits.idleTimeoutMs,
      limits: {
        parser: {
          maxBulkBytes: config.limits.maxBulkBytes,
          maxInlineBytes: config.limits.maxInlineBytes,
          maxArgs: config.limits.maxArgs,
        },
        outputBufferBytes: config.limits.outputBufferBytes,
        maxPipeline: config.limits.maxPipelineCommands,
      },
    },
  });
  const bound = await resp.listen();
  if (!bound.ok) {
    await proposer.close();
    await Promise.all([logStore.close(), stateStore.close()]);
    await tracing.shutdown();
    return err(bound.error);
  }
  // The bound port is known only now (port 0); no connection has been accepted yet.
  context.info = serverInfo(config, bound.value.port, startedAtMs);

  const expiry = new ExpiryJob({ store: stateStore, proposer, stamper, clock, logger, metrics });
  const gc = new GcJob({
    proposer,
    stamper,
    appliedIndex: () => machine.appliedIndex,
    logger,
    metrics,
  });
  expiry.start();
  gc.start();
  logger.info('node started', {
    nodeId: config.node.id,
    dataDir,
    resp: `${bound.value.address}:${String(bound.value.port)}`,
    replayed,
    appliedIndex: machine.appliedIndex,
  });

  let closing: Promise<void> | undefined;
  const close = async () => {
    await resp.close();
    await Promise.all([expiry.stop(), gc.stop()]);
    await proposer.close();
    await proposer.checkpoint();
    await Promise.all([logStore.close(), stateStore.close()]);
    await tracing.shutdown();
    logger.info('node stopped', { nodeId: config.node.id, appliedIndex: machine.appliedIndex });
  };
  return ok({
    config,
    resp: bound.value,
    logger,
    metrics,
    replayed,
    close: () => (closing ??= close()),
  });
}
