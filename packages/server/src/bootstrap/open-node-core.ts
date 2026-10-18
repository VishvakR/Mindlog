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
  replies,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvRangeHooks,
  kvWriteHandler,
} from '@mindlog/kv';
import type { NodeTransport, PdClient, ReplicaOptions, ReplicaViews } from '@mindlog/multiraft';
import {
  DEFAULT_REPLICA_OPTIONS,
  PdAgent,
  Replica,
  Store,
  SystemScheduler,
} from '@mindlog/multiraft';
import { ConnectPdClient } from '@mindlog/pd';
import { StoreRouter, connectForwardCall, fromRequest } from '@mindlog/router';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  ensureStoreFormat,
  loadTombstones,
  localRanges,
  writeTombstone,
} from '@mindlog/statemachine';
import { GroupCommitStore, LevelDbStore } from '@mindlog/storage';
import { ConnectTransport, KvForwarder, forwardRoutes } from '@mindlog/transport';
import {
  lockGuard,
  txnCheckHandler,
  txnCommitHandler,
  txnPrewriteHandler,
  txnRangeHooks,
  txnRollbackHandler,
} from '@mindlog/txn';
import type { PdRole } from './open-pd.js';
import { BINARY_VERSION, openPdRole } from './open-pd.js';

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
  /** The placement driver this process runs (embedded in a single node, or the `pd.enabled` role). */
  readonly pd: PdRole | undefined;
  /** This node's side of the placement driver; absent when the cluster has none. */
  readonly agent: PdAgent | undefined;
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

/** How this node reaches the placement driver: configured endpoints, else the PD it runs itself. */
function pdClientFor(config: MindlogConfig, pd: PdRole | undefined): PdClient | undefined {
  if (config.cluster.pdEndpoints.length > 0) return new ConnectPdClient(config.cluster.pdEndpoints);
  if (config.pd.enabled && config.pd.peers.length > 0)
    return new ConnectPdClient(config.pd.peers.map((p) => p.address));
  return pd?.client;
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
  // Cross-range transactions (ADR-0030) are in the state machine of every node or of none.
  const txnOn = config.features.crossRangeTxn;
  for (const handler of [
    kvWriteHandler(registry, txnOn ? lockGuard : undefined),
    kvBatchHandler(registry, txnOn ? lockGuard : undefined),
    expireHandler,
    gcThresholdHandler,
    ...(txnOn
      ? [
          txnPrewriteHandler(registry),
          txnCommitHandler(registry),
          txnRollbackHandler,
          txnCheckHandler,
        ]
      : []),
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
      rangeHooks: txnOn ? [kvRangeHooks, txnRangeHooks] : [kvRangeHooks],
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
  let pd: PdRole | undefined;
  let agent: PdAgent | undefined;
  let client: PdClient | undefined;
  let replica: Replica;
  // Forwarded calls arrive on the internal listener before the service exists; they wait for it.
  const running: { service?: KvService } = {};
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
        routes: forwardRoutes(
          () => async (request) => {
            const forwarded = fromRequest(request);
            if (!running.service || !forwarded)
              return replies.error('UNAVAILABLE', 'the node is starting');
            return running.service.forwarded(forwarded.rangeId, forwarded.caller, forwarded.call);
          },
          clockSync,
        ),
      });
    }
    const bootstrap = config.cluster.join ? {} : { bootstrap: peers };
    const openReplica = async (rangeId: bigint, views: ReplicaViews, replicaId?: bigint) => {
      const local = rangeId === 1n ? machine : await openMachine(rangeId);
      return Replica.open({
        rangeId,
        // A replica made for a message has the id the message names; one reopened keeps its own.
        raftId: replicaId ?? local.replicaId ?? raftId,
        options,
        log: rangeId === 1n ? log : new RaftLogStore(groupLog, rangeId),
        machine: local,
        transport: views.transport,
        scheduler: views.scheduler,
        ranges: views.ranges,
        fence: clockSync,
        clock,
        random: new SystemRandom(),
        logger,
        metrics,
        tracer,
        // A replica made for a message (it has an id) waits for a snapshot instead of bootstrapping.
        ...(rangeId === 1n && replicaId === undefined ? bootstrap : {}),
      });
    };
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
      tombstones: await loadTombstones(stateStore),
      bury: (rangeId, replicaId) => writeTombstone(stateStore, rangeId, replicaId),
    });
    replica = await store.addRange(1n);
    for (const rangeId of await localRanges(stateStore))
      if (rangeId !== 1n) await store.addRange(rangeId);
    if (single) await replica.leaderKnown();
    // The placement driver: embedded in a single node, a role of cluster nodes with `pd.enabled`,
    // and otherwise reached over the network (PLAN 8.3, ADR-0010).
    if (single || config.pd.enabled)
      pd = await openPdRole({
        config,
        logger,
        metrics,
        clock,
        tracer,
        clockSync,
        stamper,
        options,
        network: !single,
      });
    client = pdClientFor(config, pd);
    if (client) {
      agent = new PdAgent(store, client, new SystemScheduler(), {
        node: {
          nodeId: raftId,
          address: transport?.self ?? '',
          zone: config.node.zone,
          binaryVersion: BINARY_VERSION,
        },
        storeHeartbeatMs: config.pd.storeHeartbeatMs,
        rangeHeartbeatMs: config.pd.rangeHeartbeatMs,
        logger,
      });
      agent.start();
    }
  } catch (cause: unknown) {
    await agent?.stop();
    await pd?.close();
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
  const router = new StoreRouter({
    ranges: store,
    state: stateStore,
    ...(client ? { pd: client } : {}),
    nodes: () => agent?.nodes ?? new Map(),
    clock,
    send: connectForwardCall(new KvForwarder(), clockSync, () => transport?.self ?? ''),
  });
  const service = new KvService({
    registry,
    store: stateStore,
    proposer: replica,
    readBarrier: replica,
    router,
    ...(txnOn && client ? { tso: () => client.tso(1) } : {}),
    stamper,
    clock,
    authenticator: new StaticAuthenticator(config.auth.password),
    metrics,
    tracer,
    maxTransactionCommands: config.limits.maxTransactionCommands,
  });
  running.service = service;
  const started = store as Store | undefined;
  if (!started) throw new Error('the store opens before the replica');
  return ok({
    dataDir,
    machine,
    replica,
    store: started,
    pd,
    agent,
    transport,
    stamper,
    stateStore,
    service,
    replayed: Number(machine.appliedIndex - before),
    async close() {
      await agent?.stop();
      await started.close();
      await pd?.close();
      await transport?.close();
      await machine.flush();
      await Promise.all([logStore.close(), stateStore.close()]);
    },
  });
}
