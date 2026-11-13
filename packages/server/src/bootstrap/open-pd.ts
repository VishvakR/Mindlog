import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ClockSync,
  Clock,
  Logger,
  Metrics,
  MindlogConfig,
  MindlogError,
  TlsProvider,
  Tracer,
} from '@mindlog/core';
import { SYSTEM_TENANT, SystemRandom } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { NodeTransport, ReplicaOptions } from '@mindlog/multiraft';
import { Replica, Store, SystemScheduler } from '@mindlog/multiraft';
import {
  DEFAULT_PD_CONFIG,
  InProcessPdClient,
  PD_DESCRIPTOR,
  PD_HANDLERS,
  PD_RANGE_ID,
  PdService,
  pdRoutes,
} from '@mindlog/pd';
import type { CommandStamper } from '@mindlog/statemachine';
import {
  ApplyHandlerRegistry,
  RaftLogStore,
  StateMachine,
  ensureStoreFormat,
} from '@mindlog/statemachine';
import { GroupCommitStore, LevelDbStore } from '@mindlog/storage';
import { encrypted, masterKeyOf } from './open-encrypted.js';
import { ConnectTransport } from '@mindlog/transport';

/** A PD with no peers (a one-voter group) has nobody to send to. */
const NO_PEERS: NodeTransport = {
  attach: () => {},
  send: () => {},
  sendSnapshot: () => Promise.resolve(false),
};

export interface PdRole {
  readonly service: PdService;
  /** A client that talks to this PD without the network. */
  readonly client: InProcessPdClient;
  /** The replica of range 0, for backups (ADR-0041). */
  readonly store: Store;
  close(): Promise<void>;
}

export interface PdRoleDeps {
  readonly config: MindlogConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly clock: Clock;
  readonly tracer: Tracer;
  readonly clockSync: ClockSync;
  readonly stamper: CommandStamper;
  readonly options: ReplicaOptions;
  /** Serve the PD group on `pd.listen` (a cluster PD) instead of staying in this process (single-node). */
  readonly network: boolean;
  /** Mutual TLS between PD members. */
  readonly tls?: TlsProvider;
}

/**
 * Starts this process's placement driver replica (ADR-0010): its own data
 * directory, its own Raft group of range 0 on `pd.listen` next to the
 * `PdService` RPCs, and the leader-side service with its scheduler loop.
 */
export async function openPdRole(deps: PdRoleDeps): Promise<PdRole> {
  const { config, logger, metrics, clock, clockSync, options } = deps;
  const raftId = BigInt(config.node.raftId);
  const dir = resolve(config.pd.dataDir ?? join(config.node.dataDir, 'pd'));
  await mkdir(dir, { recursive: true });
  const rawLog = await LevelDbStore.open(join(dir, 'raftlog'));
  const rawState = await LevelDbStore.open(join(dir, 'state'));
  if (!rawLog.ok || !rawState.ok) {
    await Promise.all([rawLog.ok && rawLog.value.close(), rawState.ok && rawState.value.close()]);
    throw new Error(`cannot open the placement driver stores in ${dir}`);
  }
  const master = masterKeyOf(config);
  if (!master.ok) throw new Error(master.error.message);
  const log = await encrypted(rawLog.value, master.value, 'pd log');
  const state = await encrypted(rawState.value, master.value, 'pd state');
  if (!log.ok || !state.ok) {
    await Promise.all([rawLog.value.close(), rawState.value.close()]);
    throw new Error((!log.ok ? log : (state as { error: MindlogError })).error.message);
  }
  for (const [store, name] of [
    [log.value, 'pd log'],
    [state.value, 'pd state'],
  ] as const) {
    const formatted = await ensureStoreFormat(store, name);
    if (!formatted.ok) throw new Error(formatted.error.message);
  }
  const handlers = new ApplyHandlerRegistry();
  for (const h of PD_HANDLERS) handlers.register(h);
  const events = new InMemoryEventBus({ logger, metrics });
  const group = new GroupCommitStore(log.value);
  const peers = deps.network
    ? config.pd.peers.map((p) => ({ id: BigInt(p.id), address: p.address }))
    : [];
  const members = peers.length > 0 ? peers : [{ id: raftId, address: '' }];
  const advertise = members.find((p) => p.id === raftId)?.address;
  const running: { service?: PdService } = {};
  const transport = deps.network
    ? await ConnectTransport.start({
        host: config.pd.listen.host,
        port: config.pd.listen.port,
        ...(deps.tls ? { tls: deps.tls } : {}),
        ...(advertise ? { advertise } : {}),
        clock: clockSync,
        logger,
        metrics,
        // The service exists by the time a request can arrive.
        routes: pdRoutes(() => {
          if (!running.service) throw new Error('the placement driver is starting');
          return running.service;
        }),
      })
    : undefined;
  const store = Store.start({
    nodeId: raftId,
    transport: transport ?? NO_PEERS,
    scheduler: new SystemScheduler(),
    clock,
    logger,
    tickMs: options.tickMs,
    electionTicks: options.electionTicks[0],
    stamp: (body) => deps.stamper.stamp(SYSTEM_TENANT, 'system:pd', body),
    openReplica: async (rangeId, views, replicaId) => {
      const machine = await StateMachine.open({
        store: state.value,
        handlers,
        events,
        clock,
        logger,
        metrics,
        rangeId,
        descriptor: PD_DESCRIPTOR,
      });
      return Replica.open({
        rangeId,
        raftId: replicaId ?? machine.replicaId ?? raftId,
        options,
        log: new RaftLogStore(group, rangeId),
        machine,
        transport: views.transport,
        scheduler: views.scheduler,
        ranges: views.ranges,
        fence: clockSync,
        clock,
        random: new SystemRandom(),
        logger,
        metrics,
        tracer: deps.tracer,
        bootstrap: members,
      });
    },
  });
  const replica = await store.addRange(PD_RANGE_ID);
  // A one-voter group elects itself at once; a cluster PD finds its leader in the background.
  if (members.length === 1) await replica.leaderKnown();
  const service = new PdService({
    group: replica,
    reader: state.value,
    clock,
    stamper: deps.stamper,
    hlc: clockSync.hlc,
    logger,
    metrics,
    config: {
      ...DEFAULT_PD_CONFIG,
      replicas: config.ranges.replicas,
      maxBytes: BigInt(config.ranges.maxBytes),
      mergeBelowBytes: BigInt(config.ranges.mergeBelowBytes),
      splitQps: config.ranges.splitQps,
      splitQpsWindowMs: config.ranges.splitQpsWindowMs,
    },
    storeHeartbeatMs: config.pd.storeHeartbeatMs,
    deadAfterMs: config.pd.deadAfterMs,
    tsoWindowMs: config.pd.tsoWindowMs,
    binaryVersion: BINARY_VERSION,
  });
  running.service = service;
  service.start(config.pd.schedulerIntervalMs);
  return {
    service,
    client: new InProcessPdClient(service),
    store,
    async close() {
      service.stop();
      await store.close();
      await transport?.close();
      await Promise.all([log.value.close(), state.value.close()]);
    },
  };
}

/** The phase 4 binary: the lowest binary version the cluster version may rise to (PLAN 19.5). */
export const BINARY_VERSION = 10;
