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
import type { ReplicaOptions } from '@mindlog/multiraft';
import {
  DEFAULT_REPLICA_OPTIONS,
  Replica,
  SystemScheduler,
  startSingleNode,
} from '@mindlog/multiraft';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  ensureStoreFormat,
} from '@mindlog/statemachine';
import { LevelDbStore } from '@mindlog/storage';
import { ConnectTransport } from '@mindlog/transport';

export interface CoreDeps {
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
  readonly tracer: Tracer;
}

/** Storage, the range replica, the state machine and the KV service, without client listeners. */
export interface NodeCore {
  readonly dataDir: string;
  readonly machine: StateMachine;
  /** The range replica: the Proposer and ReadBarrier of this node. */
  readonly replica: Replica;
  /** Internal Raft listener; absent for a single-voter node. */
  readonly transport: ConnectTransport | undefined;
  readonly stamper: CommandStamper;
  readonly stateStore: LevelDbStore;
  readonly service: KvService;
  /** Log entries applied while opening (ADR-0005). */
  readonly replayed: number;
  /** Stops the replica, flushes state and closes the stores. */
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
  const formats = [
    await ensureStoreFormat(log.value, 'log'),
    await ensureStoreFormat(state.value, 'state'),
  ];
  for (const format of formats) {
    if (format.ok) continue;
    await Promise.all([log.value.close(), state.value.close()]);
    return format;
  }
  return ok({ log: log.value, state: state.value });
}

/** A node with no `cluster.peers` (and not joining) runs as a one-voter range. */
export const isSingleNode = (config: MindlogConfig): boolean =>
  config.cluster.peers.length === 0 && !config.cluster.join;

function replicaOptions(config: MindlogConfig): ReplicaOptions {
  const r = config.raft;
  return {
    ...DEFAULT_REPLICA_OPTIONS,
    tickMs: r.tickMs,
    electionTicks: [r.electionTicks[0], r.electionTicks[1]],
    heartbeatTicks: r.heartbeatTicks,
    leaseTicks: r.leaseTicks,
    maxInflightMsgs: r.maxInflightMsgs,
    maxInflightBytes: r.maxInflightBytes,
    maxEntryBatchBytes: r.maxEntryBatchBytes,
    snapshotEntries: r.snapshotEntries,
    trailingEntries: r.trailingEntries,
    snapshotChunkBytes: r.snapshotChunkBytes,
    maxPendingProposals: config.limits.maxPendingProposals,
  };
}

/**
 * Opens a node's data directory and its range replica: the part shared by
 * the server and offline CLI commands such as `superuser upsert`. A single
 * node elects itself before this returns; a cluster member starts its
 * internal listener and finds its peers in the background.
 */
export async function openNodeCore(
  config: MindlogConfig,
  deps: CoreDeps,
): Promise<Result<NodeCore, MindlogError>> {
  const { logger, metrics, clock, tracer } = deps;
  const raftId = BigInt(config.node.raftId);
  const single = isSingleNode(config);
  if (
    !single &&
    !config.cluster.join &&
    !config.cluster.peers.some((p) => BigInt(p.id) === raftId)
  ) {
    return err(
      mindlogError('CONFIG_INVALID', `node.raftId ${raftId} is not listed in cluster.peers`, {
        fields: { 'node.raftId': 'must be one of cluster.peers[].id' },
      }),
    );
  }
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
  const before = machine.appliedIndex;
  const log = new RaftLogStore(logStore);
  const options = replicaOptions(config);
  let transport: ConnectTransport | undefined;
  let replica: Replica;
  try {
    if (single) {
      replica = await startSingleNode({
        log,
        machine,
        clock,
        logger,
        metrics,
        tracer,
        raftId,
        options,
      });
    } else {
      transport = await ConnectTransport.start({
        host: config.listen.internal.host,
        port: config.listen.internal.port,
        logger,
        metrics,
      });
      const peers = config.cluster.peers.map((p) => ({ id: BigInt(p.id), address: p.address }));
      replica = await Replica.open({
        rangeId: 1n,
        raftId,
        options,
        log,
        machine,
        transport,
        scheduler: new SystemScheduler(),
        clock,
        random: new SystemRandom(),
        logger,
        metrics,
        tracer,
        ...(config.cluster.join ? {} : { bootstrap: peers }),
      });
      replica.start();
    }
  } catch (cause: unknown) {
    await transport?.close();
    await Promise.all([logStore.close(), stateStore.close()]);
    return err(
      mindlogError(
        'UNAVAILABLE',
        `cannot start the replica: ${cause instanceof Error ? cause.message : String(cause)}`,
        {
          cause,
        },
      ),
    );
  }
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: BigInt(config.cluster.maxClockOffsetMs) }),
    new UlidGenerator(clock, new SystemRandom()),
  );
  const service = new KvService({
    registry,
    store: stateStore,
    proposer: replica,
    readBarrier: replica,
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
    replica,
    transport,
    stamper,
    stateStore,
    service,
    replayed: Number(machine.appliedIndex - before),
    async close() {
      await replica.close();
      await transport?.close();
      await machine.flush();
      await Promise.all([logStore.close(), stateStore.close()]);
    },
  });
}
