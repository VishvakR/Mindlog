import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Clock,
  Hlc,
  Logger,
  Metrics,
  MindlogConfig,
  MindlogError,
  Result,
  Tracer,
} from '@mindlog/core';
import {
  ClockSync,
  SYSTEM_TENANT,
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
  kvRangeHooks,
  kvWriteHandler,
} from '@mindlog/kv';
import type { NodeTransport, ReplicaOptions, ReplicaViews } from '@mindlog/multiraft';
import { DEFAULT_REPLICA_OPTIONS, Replica, Store, SystemScheduler } from '@mindlog/multiraft';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  ensureStoreFormat,
  localRanges,
} from '@mindlog/statemachine';
import { GroupCommitStore, LevelDbStore } from '@mindlog/storage';
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
  /** All replicas of this node. */
  readonly store: Store;
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

/** A single-voter node has no peers to reach. */
const NO_PEERS: NodeTransport = {
  attach: () => {},
  send: () => {},
  sendSnapshot: () => Promise.resolve(false),
};

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
  const options = replicaOptions(config);
  const clockSync = new ClockSync({
    clock,
    maxOffsetMs: BigInt(config.cluster.maxClockOffsetMs),
    holdMs: 2 * options.electionTicks[1] * options.tickMs,
    metrics,
    logger,
  });
  const stamper = new CommandStamper(clockSync.hlc, new UlidGenerator(clock, new SystemRandom()));
  const events = new InMemoryEventBus({ logger, metrics });
  events.subscribe('CommandApplied', (e) => {
    clockSync.observe(e.command.hlc as Hlc);
  });
  const openMachine = (rangeId: bigint) =>
    StateMachine.open({
      store: stateStore,
      handlers,
      rangeHooks: [kvRangeHooks],
      events,
      clock,
      logger,
      metrics,
      rangeId,
    });
  const machine = await openMachine(1n);
  const before = machine.appliedIndex;
  // One fsync per turn for the log appends of every range (PLAN 8.2).
  const groupLog = new GroupCommitStore(logStore);
  const log = new RaftLogStore(groupLog);
  let transport: ConnectTransport | undefined;
  let store: Store | undefined;
  let replica: Replica;
  try {
    const peers = single
      ? [{ id: raftId, address: '' }]
      : config.cluster.peers.map((p) => ({ id: BigInt(p.id), address: p.address }));
    if (!single) {
      const advertise = peers.find((p) => p.id === raftId)?.address;
      transport = await ConnectTransport.start({
        host: config.listen.internal.host,
        port: config.listen.internal.port,
        ...(advertise ? { advertise } : {}),
        clock: clockSync,
        logger,
        metrics,
      });
    }
    const bootstrap = config.cluster.join ? {} : { bootstrap: peers };
    const openReplica = async (rangeId: bigint, views: ReplicaViews) =>
      Replica.open({
        rangeId,
        raftId,
        options,
        log: rangeId === 1n ? log : new RaftLogStore(groupLog, rangeId),
        machine: rangeId === 1n ? machine : await openMachine(rangeId),
        transport: views.transport,
        scheduler: views.scheduler,
        ranges: views.ranges,
        fence: clockSync,
        clock,
        random: new SystemRandom(),
        logger,
        metrics,
        tracer,
        ...(rangeId === 1n ? bootstrap : {}),
      });
    store = Store.start({
      nodeId: raftId,
      transport: transport ?? NO_PEERS,
      scheduler: new SystemScheduler(),
      clock,
      logger,
      tickMs: options.tickMs,
      electionTicks: options.electionTicks[0],
      stamp: (body) => stamper.stamp(SYSTEM_TENANT, 'system:range', body),
      openReplica,
    });
    replica = await store.addRange(1n);
    for (const rangeId of await localRanges(stateStore))
      if (rangeId !== 1n) await store.addRange(rangeId);
    if (single) await replica.leaderKnown();
  } catch (cause: unknown) {
    await store?.close();
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
  const started = store as Store | undefined;
  if (!started) throw new Error('the store opens before the replica');
  return ok({
    dataDir,
    machine,
    replica,
    store: started,
    transport,
    stamper,
    stateStore,
    service,
    replayed: Number(machine.appliedIndex - before),
    async close() {
      await started.close();
      await transport?.close();
      await machine.flush();
      await Promise.all([logStore.close(), stateStore.close()]);
    },
  });
}
