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
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import type { WorkerRegistry } from '@mindlog/jobs';
import {
  conflictResolveHandler,
  liveMemory,
  memoryCommitHandler,
  memoryForgetHandler,
  memoryTrustHandler,
  branchCreateHandler,
  branchMergeHandler,
  branchDropHandler,
} from '@mindlog/memory';
import { cacheInvalidateHandler, cacheSetHandler } from '@mindlog/cache';
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
import type { ChangeFeed, MemoryService, PdAdmin } from '@mindlog/services';
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
import { openMemory } from './open-memory.js';

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
  /** PD's cluster view and operator actions, for the dashboard; absent without a placement driver. */
  readonly pdAdmin: PdAdmin | undefined;
  /** Internal Raft listener; absent for a single-voter node. */
  readonly transport: ConnectTransport | undefined;
  readonly stamper: CommandStamper;
  readonly stateStore: LevelDbStore;
  readonly service: KvService;
  /** Memory requests (PLAN 12); routed to the leader of each user scope. */
  readonly memory: MemoryService;
  /** Memory change stream (PLAN 13.5). */
  readonly changes: ChangeFeed;
  /** Job workers for the range jobs (ADR-0017). */
  readonly workers: WorkerRegistry;
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
function pdClientFor(
  config: MindlogConfig,
  pd: PdRole | undefined,
): (PdClient & PdAdmin) | undefined {
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
    // Memory and jobs (ADR-0032): every v5 binary applies them; proposing waits for cluster version 5.
    memoryCommitHandler,
    memoryForgetHandler,
    jobLeaseHandler,
    jobCompleteHandler,
    // The semantic cache (ADR-0012): every v6 binary applies it; proposing waits for cluster version 6.
    cacheSetHandler(liveMemory),
    cacheInvalidateHandler,
    // Conflict review (ADR-0015): every v7 binary applies it; proposing waits for cluster version 7.
    conflictResolveHandler,
    memoryTrustHandler,
    branchCreateHandler,
    branchMergeHandler,
    branchDropHandler,
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
      rangeHooks: txnOn
        ? [kvRangeHooks, jobRangeHooks, txnRangeHooks]
        : [kvRangeHooks, jobRangeHooks],
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
  let client: (PdClient & PdAdmin) | undefined;
  let replica: Replica;
  // Forwarded calls arrive on the internal listener before the service exists; they wait for it.
  const running: { service?: KvService; memory?: MemoryService } = {};
  try {
    const peers = single
      ? [{ id: raftId, address: '' }]
      : config.cluster.peers.map((p) => ({ id: BigInt(p.id), address: p.address }));
    if (!single) {
      const advertise = peers.find((p) => p.id === raftId)?.address ?? config.cluster.advertise;
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
            if (!running.service || !running.memory || !forwarded)
              return replies.error('UNAVAILABLE', 'the node is starting');
            if (forwarded.call.kind === 'memory')
              return running.memory.forwarded(forwarded.rangeId, forwarded.caller, forwarded.call);
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
        metrics,
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
  // A single node is its own cluster; members follow PD's cluster version (PLAN 19.5).
  const clusterVersion = (): number => (single ? BINARY_VERSION : (agent?.clusterVersion ?? 0));
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
    ...(txnOn && client ? { tso: () => gatedTso(client, clusterVersion) } : {}),
    stamper,
    clock,
    authenticator: new StaticAuthenticator(config.auth.password),
    metrics,
    tracer,
    maxTransactionCommands: config.limits.maxTransactionCommands,
  });
  const memory = openMemory({
    config,
    state: stateStore,
    events,
    stamper,
    router,
    clusterVersion,
    clock,
    metrics,
    logger,
    tracer,
  });
  running.service = service;
  running.memory = memory.service;
  const started = store as Store | undefined;
  if (!started) throw new Error('the store opens before the replica');
  return ok({
    dataDir,
    machine,
    replica,
    store: started,
    pd,
    agent,
    pdAdmin: client,
    transport,
    stamper,
    stateStore,
    service,
    memory: memory.service,
    changes: memory.changes,
    workers: memory.workers,
    replayed: Number(machine.appliedIndex - before),
    async close() {
      await agent?.stop();
      await started.close();
      await pd?.close();
      await transport?.close();
      await machine.flush();
      await Promise.all([logStore.close(), stateStore.close()]);
      await memory.close();
    },
  });
}

/** Cluster version that knows the transaction commands (ADR-0030, PLAN 19.5). */
const TXN_CLUSTER_VERSION = 4;

/** Timestamps for transactions only once every node can apply transaction commands. */
function gatedTso(client: PdClient, clusterVersion: () => number) {
  if (clusterVersion() < TXN_CLUSTER_VERSION)
    return Promise.resolve(
      err(
        mindlogError(
          'UNAVAILABLE',
          'the cluster has not reached the version of transactions yet; retry',
        ),
      ),
    );
  return client.tso(1);
}
