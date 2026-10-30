import { createHash } from 'node:crypto';
import type { Clock, Hlc } from '@mindlog/core';
import {
  ClockSync,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SYSTEM_TENANT,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { SemanticCache, cacheInvalidateHandler, cacheSetHandler } from '@mindlog/cache';
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import {
  MemoryEngine,
  VectorCache,
  liveMemory,
  memoryCommitHandler,
  memoryForgetHandler,
  conflictResolveHandler,
  memoryTrustHandler,
} from '@mindlog/memory';
import { FakeModels } from '@mindlog/models-client';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  headerKey,
  kvBatchHandler,
  kvRangeHooks,
  kvWriteHandler,
} from '@mindlog/kv';
import {
  lockGuard,
  txnCheckHandler,
  txnCommitHandler,
  txnPrewriteHandler,
  txnRangeHooks,
  txnRollbackHandler,
} from '@mindlog/txn';
import type { ReplicaOptions, ReplicaViews } from '@mindlog/multiraft';
import { DEFAULT_REPLICA_OPTIONS, PdAgent, Replica, Store } from '@mindlog/multiraft';
import { DEFAULT_PD_CONFIG, PD_DESCRIPTOR, PD_HANDLERS, PD_RANGE_ID, PdService } from '@mindlog/pd';
import { PdSwitchboard } from './sim-pd.js';
import type { KvReply, RangeDescriptor } from '@mindlog/proto';
import type { Session } from '@mindlog/services';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  inSpan,
  loadTombstones,
  localRanges,
  spanIntervals,
  writeTombstone,
} from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import type { RegisterOp } from './linearizability.js';
import { checkRegister } from './linearizability.js';
import { Bank } from './bank.js';
import { MemoryLoad } from './memory-load.js';
import { SimDisk } from './sim-disk.js';
import { SimNetwork } from './sim-network.js';
import {
  churnSomeMember,
  mergeSomeRanges,
  splitSomeRange,
  transferSomeLeader,
} from './range-faults.js';
import { NodeScheduler, World } from './world.js';

export interface FaultOptions {
  readonly partitions: boolean;
  readonly crashes: boolean;
  /** Highest message loss rate the schedule may pick. */
  readonly maxDrop: number;
  readonly duplicate: number;
  /** Clock rates are drawn from [1 − drift, 1 + drift] (ADR-0007 allows 10%). */
  readonly drift: number;
  /** Range faults (phase 4): split and merge ranges, move leaders, remove and re-add members. */
  readonly splits: boolean;
  readonly merges: boolean;
  readonly transfers: boolean;
  readonly membership: boolean;
  /** One node's clock is `skewMs` ahead from the start: its peers must fence and reads stay linearizable. */
  readonly skewMs: number;
}

export interface ScenarioOptions {
  readonly seed: bigint;
  readonly nodes: number;
  readonly clients: number;
  readonly keys: number;
  readonly durationMs: number;
  readonly faults: FaultOptions;
  readonly verbose: boolean;
  /**
   * Run the placement driver (phase 4): a PD Raft group of range 0 on the first three nodes, an
   * agent on every node, and PD alone deciding splits, merges and replica placement.
   */
  readonly pd: boolean;
  /** Nodes at the end of the list that start without any replica (PD must fill them). */
  readonly spare: number;
  /** Accounts of the bank-transfer workload (phase 4 gate, ADR-0030); 0 turns it off. */
  readonly bank: number;
  /** User scopes of the memory workload (phase 5); 0 turns it off. */
  readonly memory: number;
}

export interface SimResult {
  readonly seed: bigint;
  readonly violations: string[];
  readonly stats: {
    events: number;
    ops: number;
    unknown: number;
    crashes: number;
    partitions: number;
    splits: number;
    merges: number;
    transfers: number;
    membership: number;
    /** Event steps during which some node was fenced for clock skew. */
    fencedSteps: number;
    /** Bank-transfer workload: transfers committed, transactions that gave up, consistent audits. */
    bank: { committed: number; aborted: number; audits: number };
    /** Memory workload: memories remembered and forgotten (acknowledged). */
    memory: { remembered: number; forgotten: number };
    /** At the end: ranges, and replicas created by PD operators (ids from 1000). */
    ranges: number;
    placed: number;
  };
}

const START_MS = 1_760_000_000_000;
const SIM_OPTIONS: ReplicaOptions = {
  ...DEFAULT_REPLICA_OPTIONS,
  // Small enough that compaction and snapshot installs happen in every run.
  snapshotEntries: 64,
  trailingEntries: 8,
  snapshotChunkBytes: 4096,
};
const QUIET_MS = 30_000;
const PD_STORE_HEARTBEAT_MS = 1_000;
const PD_DEAD_AFTER_MS = 10_000;
/** Small enough that the few keys of a run split ranges, and that PD moves replicas. */
const PD_SIM_CONFIG = {
  ...DEFAULT_PD_CONFIG,
  maxBytes: 6_000n,
  mergeBelowBytes: 1_500n,
  maxOperators: 2,
  operatorTimeoutMs: 20_000,
  learnerTimeoutMs: 10_000,
};
const MAX_OFFSET_MS = 5_000n;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Incarnation {
  readonly scheduler: NodeScheduler;
  readonly store: Store;
  readonly stateStore: KvStore;
  /** One KV service per local replica, built on first use (no router yet). */
  readonly services: WeakMap<Replica, KvService>;
  /** Sessions by `rangeId/client`. */
  readonly sessions: Map<string, Session>;
  /** Newest epoch version this incarnation saw per replica (`range/replica`): it must never go back. */
  readonly epochs: Map<string, bigint>;
  readonly stamper: CommandStamper;
  readonly sync: ClockSync;
  readonly clock: Clock;
  readonly metrics: MemoryMetrics;
  readonly engine: MemoryEngine;
  readonly cache: SemanticCache;
  readonly logger: MemoryLogger;
}

interface SimNode {
  readonly id: bigint;
  readonly rate: number;
  /** Constant offset of this node's clock from true time (the skew fault). */
  readonly skewMs: number;
  readonly log: SimDisk;
  readonly state: SimDisk;
  up: Incarnation | undefined;
  booting: boolean;
  generation: number;
}

/** A clock that reads simulated time at this node's rate. */
const simClock = (world: World, rate: number, skewMs: number): Clock => ({
  now: () => BigInt(START_MS + skewMs + Math.floor(world.now * rate)),
  monotonic: () => BigInt(Math.floor(world.now * rate * 1e6)),
});

/** Runs one seed: a cluster of real replicas under random faults, then checks it (PLAN 22.2). */
export async function runScenario(o: ScenarioOptions): Promise<SimResult> {
  const world = new World(o.seed);
  const net = new SimNetwork(world);
  const violations: string[] = [];
  const stats = {
    events: 0,
    ops: 0,
    unknown: 0,
    crashes: 0,
    partitions: 0,
    splits: 0,
    merges: 0,
    transfers: 0,
    membership: 0,
    fencedSteps: 0,
    bank: { committed: 0, aborted: 0, audits: 0 },
    memory: { remembered: 0, forgotten: 0 },
    ranges: 0,
    placed: 0,
  };
  const say = (line: string): void => {
    if (o.verbose) console.log(`[${world.now.toFixed(1)}ms] ${line}`);
  };
  const ids = Array.from({ length: o.nodes }, (_, i) => BigInt(i + 1));
  const members = ids.slice(0, o.nodes - o.spare);
  const bootstrap = members.map((id) => ({ id, address: `n${id}` }));
  const pdNodes = ids.slice(0, Math.min(3, o.nodes));
  const pdBootstrap = pdNodes.map((id) => ({ id, address: `n${id}` }));
  const switchboard = new PdSwitchboard(net, (what) => {
    violate(what);
  });
  const nodes = ids.map((id): SimNode => ({
    id,
    rate: world.between(1 - o.faults.drift, 1 + o.faults.drift),
    skewMs: 0,
    log: new SimDisk(),
    state: new SimDisk(),
    up: undefined,
    booting: false,
    generation: 0,
  }));
  if (o.faults.skewMs !== 0) (world.pick(nodes) as { skewMs: number }).skewMs = o.faults.skewMs;
  const registry = createKvRegistry();
  const leaders = new Map<string, bigint>();
  const appliedAt = new Map<string, string>();
  let nextRangeId = 2n;
  let nextReplicaId = 1000n;
  const violate = (what: string): void => {
    if (violations.length < 20) violations.push(what);
    say(`VIOLATION ${what}`);
  };

  async function boot(node: SimNode): Promise<void> {
    node.booting = true;
    const generation = ++node.generation;
    const scheduler = new NodeScheduler(world, node.rate);
    const clock = simClock(world, node.rate, node.skewMs);
    const logger = new MemoryLogger('info');
    const metrics = new MemoryMetrics();
    const handlers = new ApplyHandlerRegistry();
    const guard = o.bank > 0 ? lockGuard : undefined;
    for (const h of [
      kvWriteHandler(registry, guard),
      kvBatchHandler(registry, guard),
      expireHandler,
      gcThresholdHandler,
      memoryCommitHandler,
      memoryForgetHandler,
      conflictResolveHandler,
      memoryTrustHandler,
      jobLeaseHandler,
      jobCompleteHandler,
      cacheSetHandler(liveMemory),
      cacheInvalidateHandler,
      ...PD_HANDLERS,
      ...(o.bank > 0
        ? [
            txnPrewriteHandler(registry),
            txnCommitHandler(registry),
            txnRollbackHandler,
            txnCheckHandler,
          ]
        : []),
    ])
      handlers.register(h);
    const events = new InMemoryEventBus({ logger, metrics });
    const stateStore = node.state.open();
    const logStore = node.log.open();
    events.subscribe('CommandApplied', (e) => {
      // State machine safety: one command per (range, index), on every replica (PLAN 7.5).
      const id = Buffer.from(e.command.requestId).toString('hex');
      const at = `${e.rangeId}/${e.index}`;
      const seen = appliedAt.get(at);
      if (seen === undefined) appliedAt.set(at, id);
      else if (seen !== id) violate(`n${node.id} applied ${id} at ${at}, others applied ${seen}`);
    });
    const seed = o.seed * 31n + node.id * 1000n + BigInt(generation);
    // The offset limit is above what the drift option reaches over a run (5% of 70 s), so only
    // the skew fault fences nodes.
    const sync = new ClockSync({
      clock,
      maxOffsetMs: MAX_OFFSET_MS,
      holdMs: 2 * SIM_OPTIONS.electionTicks[1] * SIM_OPTIONS.tickMs,
      metrics,
      logger,
    });
    const stamper = new CommandStamper(sync.hlc, new UlidGenerator(clock, new SeededRandom(seed)));
    events.subscribe('CommandApplied', (e) => {
      sync.observe(e.command.hlc as Hlc);
    });
    const openReplica = async (rangeId: bigint, views: ReplicaViews, replicaId?: bigint) => {
      const machine = await StateMachine.open({
        store: stateStore,
        handlers,
        rangeHooks:
          o.bank > 0 ? [kvRangeHooks, jobRangeHooks, txnRangeHooks] : [kvRangeHooks, jobRangeHooks],
        events,
        clock,
        logger,
        metrics,
        rangeId,
        ...(rangeId === PD_RANGE_ID ? { descriptor: PD_DESCRIPTOR } : {}),
      });
      return Replica.open({
        rangeId,
        raftId: replicaId ?? machine.replicaId ?? node.id,
        options: SIM_OPTIONS,
        log: new RaftLogStore(logStore, rangeId),
        machine,
        transport: views.transport,
        scheduler: views.scheduler,
        ranges: views.ranges,
        fence: sync,
        clock,
        random: new SeededRandom(
          o.seed * 7919n + node.id * 104_729n + BigInt(generation) * 13n + rangeId,
        ),
        logger,
        metrics,
        // Only a node that starts the cluster bootstraps; a replica made for a message waits for a snapshot.
        ...(rangeId === 1n && replicaId === undefined ? { bootstrap } : {}),
        ...(rangeId === PD_RANGE_ID && replicaId === undefined ? { bootstrap: pdBootstrap } : {}),
      });
    };
    const store = Store.start({
      nodeId: node.id,
      transport: net.transport(node.id, sync),
      scheduler,
      clock,
      logger,
      tickMs: SIM_OPTIONS.tickMs,
      electionTicks: SIM_OPTIONS.electionTicks[0],
      stamp: (body) => stamper.stamp(SYSTEM_TENANT, 'system:range', body),
      openReplica,
      tombstones: await loadTombstones(stateStore),
      bury: (rangeId, replicaId) => writeTombstone(stateStore, rangeId, replicaId),
    });
    if (members.includes(node.id)) await store.addRange(1n);
    for (const rangeId of await localRanges(stateStore)) await store.addRange(rangeId);
    let pd: PdService | undefined;
    if (o.pd && pdNodes.includes(node.id)) {
      const group = await store.addRange(PD_RANGE_ID);
      pd = new PdService({
        group,
        reader: stateStore,
        clock,
        stamper,
        hlc: sync.hlc,
        logger,
        metrics,
        config: PD_SIM_CONFIG,
        storeHeartbeatMs: PD_STORE_HEARTBEAT_MS,
        deadAfterMs: PD_DEAD_AFTER_MS,
        tsoWindowMs: 1000,
      });
      scheduler.every(1000, () => void pd?.tick());
      switchboard.set(node.id, pd);
    }
    if (o.pd) {
      new PdAgent(store, switchboard.client(node.id), scheduler, {
        node: { nodeId: node.id, address: `n${node.id}`, zone: `z${node.id}`, binaryVersion: 4 },
        storeHeartbeatMs: PD_STORE_HEARTBEAT_MS,
        rangeHeartbeatMs: 500,
        gcIntervalMs: 4_000,
        logger,
      }).start();
    }
    if (generation !== node.generation) {
      await store.close();
      return;
    }
    const vectors = new VectorCache({ state: stateStore, maxScopes: 16 });
    vectors.attach(events);
    const engine = new MemoryEngine({
      models: new FakeModels(),
      stamper,
      ids: new UlidGenerator(clock, new SeededRandom(seed + 7n)),
      clock,
      metrics,
      logger,
      tracer: new OtelTracer(),
      vectors,
      ranges: () => undefined,
    });
    const cache = new SemanticCache({
      models: new FakeModels(),
      stamper,
      ids: new UlidGenerator(clock, new SeededRandom(seed + 11n)),
      clock,
      metrics,
      tracer: new OtelTracer(),
    });
    node.up = {
      scheduler,
      store,
      stateStore,
      engine,
      cache,
      services: new WeakMap(),
      sessions: new Map(),
      epochs: new Map(),
      stamper,
      sync,
      clock,
      metrics,
      logger,
    };
    node.booting = false;
    say(`n${node.id} up`);
  }

  /** The node's KV service for the local range that holds `key` (a stand-in for the router). */
  function route(
    up: Incarnation,
    key: string,
  ): { replica: Replica; service: KvService } | undefined {
    const header = headerKey('default', encoder.encode(key));
    const replica = up.store.replicas().find((r) => r.initialised && inSpan(r.descriptor, header));
    if (!replica) return undefined;
    let service = up.services.get(replica);
    if (!service) {
      service = new KvService({
        registry,
        store: up.stateStore,
        proposer: replica,
        readBarrier: replica,
        stamper: up.stamper,
        clock: up.clock,
        authenticator: new StaticAuthenticator(undefined),
        metrics: up.metrics,
        tracer: { withSpan: (_name, _attrs, fn) => fn({ setAttribute: () => {} }) },
      });
      up.services.set(replica, service);
    }
    return { replica, service };
  }

  function session(up: Incarnation, rangeId: bigint, service: KvService, name: string): Session {
    const key = `${rangeId}/${name}`;
    let found = up.sessions.get(key);
    if (!found) {
      found = service.openSession(name);
      up.sessions.set(key, found);
    }
    return found;
  }

  async function crash(node: SimNode, powerLoss: boolean): Promise<void> {
    if (!node.up) return;
    node.up.scheduler.alive = false;
    node.up = undefined;
    switchboard.set(node.id, undefined);
    net.detach(node.id);
    stats.crashes++;
    const keepLog = Math.floor(world.between(0, node.log.unsyncedBatches + 1));
    const keepState = Math.floor(world.between(0, node.state.unsyncedBatches + 1));
    say(`n${node.id} ${powerLoss ? 'loses power' : 'is killed'}`);
    await node.log.crash(powerLoss, keepLog);
    await node.state.crash(powerLoss, keepState);
  }

  function checkStep(): void {
    stats.events++;
    if (nodes.some((n) => n.up?.sync.fenced)) stats.fencedSteps++;
    for (const node of nodes) {
      const up = node.up;
      if (!up) continue;
      for (const replica of up.store.replicas()) {
        const s = replica.status();
        const range = replica.rangeId;
        if (s.applied > s.commit || s.commit > s.lastIndex)
          violate(
            `n${node.id} r${range}: applied ${s.applied} commit ${s.commit} last ${s.lastIndex}`,
          );
        // A replica made anew (after a removal) starts from nothing, so epochs are kept per replica.
        const epochKey = `${range}/${replica.replicaId}`;
        const epoch = replica.descriptor.epoch?.version ?? 0n;
        if (epoch < (up.epochs.get(epochKey) ?? 0n))
          violate(`n${node.id} r${range}: epoch went back to ${epoch}`);
        up.epochs.set(epochKey, epoch);
        if (s.role !== 'leader') continue;
        const term = `${range}/${s.term}`;
        const known = leaders.get(term);
        if (known === undefined) leaders.set(term, node.id);
        else if (known !== node.id)
          violate(`two leaders of range ${range} in term ${s.term}: n${known} and n${node.id}`);
      }
    }
  }

  // ---- clients ----
  const history = new Map<string, RegisterOp[]>();
  let clientsOn = true;
  const record = (key: string, op: RegisterOp): void => {
    const list = history.get(key) ?? [];
    list.push(op);
    history.set(key, list);
    if (op.outcome === 'unknown') stats.unknown++;
  };

  function client(c: number): void {
    const lastSeen = new Map<string, string | null>();
    let n = 0;
    const next = (): void => {
      if (!clientsOn) return;
      world.at(world.now + world.between(5, 60), issue);
    };
    const issue = (): void => {
      const live = nodes.filter((x) => x.up);
      if (live.length === 0) {
        next();
        return;
      }
      const node = world.pick(live);
      const up = node.up as Incarnation;
      const key = `k${Math.floor(world.between(0, o.keys))}`;
      const roll = world.random.next();
      const kind: RegisterOp['kind'] = roll < 0.4 ? 'read' : roll < 0.75 ? 'write' : 'cas';
      const value = `c${c}-${n++}`;
      const from = lastSeen.get(key) ?? `c${c}-${Math.max(0, n - 3)}`;
      const argv =
        kind === 'read'
          ? ['GET', key]
          : kind === 'write'
            ? ['SET', key, value]
            : ['SET', key, value, 'IFEQ', from];
      const routed = route(up, key);
      if (!routed) {
        next();
        return;
      }
      const { replica, service } = routed;
      const epoch = replica.descriptor.epoch?.version;
      const header = headerKey('default', encoder.encode(key));
      const client = session(up, replica.rangeId, service, `client-${c}`);
      const invoke = world.now;
      let done = false;
      stats.ops++;
      const finish = (
        op: Omit<RegisterOp, 'invoke' | 'complete'> | undefined,
        complete: number,
      ): void => {
        if (done) return;
        done = true;
        if (op) record(key, { ...op, invoke, complete });
        next();
      };
      world.at(invoke + 4000, () => {
        if (kind !== 'read')
          finish(
            { kind, value, ...(kind === 'cas' ? { from } : {}), outcome: 'unknown' },
            Infinity,
          );
        else finish(undefined, 0);
      });
      void service
        .execute(
          client,
          argv.map((a) => encoder.encode(a)),
        )
        .then(
          (reply) => {
            // A read is valid only if its range kept the key throughout (the router's job later).
            const moved =
              replica.descriptor.epoch?.version !== epoch || !inSpan(replica.descriptor, header);
            if (kind === 'read' && moved) {
              finish(undefined, 0);
              return;
            }
            const outcome = classify(kind, reply);
            if (outcome === 'drop') {
              finish(undefined, 0);
              return;
            }
            if (kind === 'read') {
              const seen = outcome === 'ok' ? readValue(reply) : null;
              lastSeen.set(key, seen);
              finish({ kind, value: seen, outcome: 'ok' }, world.now);
              return;
            }
            if (outcome === 'ok') lastSeen.set(key, value);
            const complete = outcome === 'unknown' ? Infinity : world.now;
            finish({ kind, value, ...(kind === 'cas' ? { from } : {}), outcome }, complete);
          },
          () => {
            finish(kind === 'read' ? undefined : { kind, value, outcome: 'unknown' }, Infinity);
          },
        );
    };
    next();
  }

  // ---- fault schedule ----
  let faultsOn = true;
  const ranges = {
    world,
    live: () => nodes.flatMap((n) => (n.up ? [n.up.store] : [])),
    say,
    nextRangeId: () => nextRangeId++,
    nextReplicaId: () => nextReplicaId++,
    count: (kind: 'splits' | 'merges' | 'transfers' | 'membership') => {
      stats[kind]++;
    },
  };
  function scheduleFault(): void {
    world.at(world.now + world.between(500, 3000), () => {
      if (!faultsOn) return;
      const roll = world.random.next();
      const f = o.faults;
      if (f.partitions && roll < 0.25) {
        const shuffled = [...ids].sort(() => world.random.next() - 0.5);
        const cut = 1 + Math.floor(world.between(0, ids.length - 1));
        net.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
        stats.partitions++;
        say(`partition ${shuffled.slice(0, cut).join(',')} | ${shuffled.slice(cut).join(',')}`);
      } else if (roll < 0.4) {
        net.heal();
        say('heal');
      } else if (roll < 0.7) {
        const r = world.random.next();
        if (f.splits && r < 0.3) splitSomeRange(ranges);
        else if (f.merges && r < 0.6) mergeSomeRanges(ranges);
        else if (f.transfers && r < 0.8) transferSomeLeader(ranges);
        else if (f.membership) churnSomeMember(ranges);
      } else if (f.crashes && roll < 0.88) {
        const alive = nodes.filter((x) => x.up);
        if (alive.length > 0) {
          const victim = world.pick(alive);
          void crash(victim, world.chance(0.5)).then(() => {
            world.at(world.now + world.between(200, 3000), () => {
              void boot(victim);
            });
          });
        }
      } else {
        net.faults.drop = world.between(0, o.faults.maxDrop);
        net.faults.duplicate = o.faults.duplicate;
        net.faults.latency = [world.between(0.5, 3), world.between(3, 20)];
        say(`network drop ${net.faults.drop.toFixed(3)}`);
      }
      scheduleFault();
    });
  }

  const bank =
    o.bank > 0
      ? new Bank({
          world,
          registry,
          nodes: () =>
            nodes.flatMap((n) =>
              n.up
                ? [
                    {
                      id: n.id,
                      store: n.up.store,
                      stateStore: n.up.stateStore,
                      stamper: n.up.stamper,
                    },
                  ]
                : [],
            ),
          startMs: START_MS,
          accounts: o.bank,
          initial: 100,
          say,
          violate,
          splitSome: () => {
            splitSomeRange(ranges);
          },
        })
      : undefined;
  if (bank) {
    world.at(1000, () => void bank.setup());
    const every = (lo: number, hi: number, work: () => Promise<void>): void => {
      const tick = (): void => {
        if (!clientsOn) return;
        void work().finally(() => {
          world.at(world.now + world.between(lo, hi), tick);
        });
      };
      world.at(world.now + world.between(lo, hi), tick);
    };
    for (let w = 0; w < 3; w++) every(20, 120, () => bank.transfer());
    every(300, 900, () => bank.audit());
  }

  const memory =
    o.memory > 0
      ? new MemoryLoad({
          world,
          nodes: () =>
            nodes.flatMap((n) =>
              n.up
                ? [
                    {
                      id: n.id,
                      store: n.up.store,
                      stateStore: n.up.stateStore,
                      engine: n.up.engine,
                      cache: n.up.cache,
                    },
                  ]
                : [],
            ),
          users: o.memory,
          say,
          violate,
        })
      : undefined;
  if (memory) {
    const every = (lo: number, hi: number, work: () => Promise<void>): void => {
      const tick = (): void => {
        if (!clientsOn) return;
        void work().finally(() => {
          world.at(world.now + world.between(lo, hi), tick);
        });
      };
      world.at(world.now + world.between(lo, hi), tick);
    };
    for (let w = 0; w < 2; w++) every(50, 250, () => memory.remember());
    every(400, 1200, () => memory.forget());
    every(300, 900, () => memory.cacheStore());
  }

  // ---- run ----
  for (const node of nodes) world.at(0, () => void boot(node));
  for (let c = 0; c < o.clients; c++) client(c);
  const f = o.faults;
  if (f.partitions || f.crashes || f.maxDrop > 0 || f.splits || f.merges || f.transfers)
    scheduleFault();
  try {
    await world.run(o.durationMs, checkStep);
    faultsOn = false;
    clientsOn = false;
    net.heal();
    net.faults.drop = 0;
    net.faults.duplicate = 0;
    net.faults.latency = [1, 5];
    for (const node of nodes)
      if (!node.up && !node.booting) world.at(world.now, () => void boot(node));
    say('healing');
    await world.run(o.durationMs + QUIET_MS, checkStep);
    await finalChecks();
  } catch (cause: unknown) {
    violate(`crashed: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`);
  }
  if (o.verbose && violations.length > 0) {
    if (o.pd) console.log(switchboard.describe());
    const fmt = (v: unknown): string =>
      JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
    for (const node of nodes) {
      for (const r of node.up?.store.replicas() ?? []) {
        const s = r.status();
        console.log(
          `n${node.id} r${r.rangeId} status`,
          fmt({ ...s, confState: s.confState }),
          'quiesced',
          r.quiesced,
        );
      }
    }
    for (const node of nodes) {
      for (const e of node.up?.logger.entries.slice(-30) ?? [])
        console.log(`n${node.id}`, e.level, e.message);
    }
  }
  return { seed: o.seed, violations, stats };

  async function finalChecks(): Promise<void> {
    if (bank) await bankSettle(bank);
    if (memory)
      for (let pass = 0; pass < 10 && memory.inFlight > 0; pass++)
        await world.run(world.now + 5000, checkStep);
    const up = nodes.map((n) => n.up);
    if (up.some((u) => !u)) {
      violate('a node did not come back up');
      return;
    }
    const live = up as Incarnation[];
    for (const node of nodes) {
      for (const r of node.up?.store.replicas() ?? []) {
        const failure: unknown = r.failure;
        if (failure !== undefined)
          violate(
            `n${node.id} r${r.rangeId} stopped: ${failure instanceof Error ? failure.message : 'failure'}`,
          );
      }
    }
    // The leaders' descriptors must tile the keyspace; replicas left behind by a
    // removal are ignored (replica GC is PD's job).
    const leaderOf = new Map<bigint, { node: SimNode; replica: Replica }>();
    for (const node of nodes)
      for (const replica of node.up?.store.replicas() ?? [])
        if (replica.isLeader() && replica.rangeId !== PD_RANGE_ID)
          leaderOf.set(replica.rangeId, { node, replica });
    // A zombie leader of a range that was merged away elsewhere never hears of it (replica GC
    // is PD's job, phase 4 task 6): of overlapping ranges the highest epoch is the live one.
    const byEpoch = [...leaderOf.values()].sort((x, y) =>
      Number(
        (y.replica.descriptor.epoch?.version ?? 0n) - (x.replica.descriptor.epoch?.version ?? 0n),
      ),
    );
    const tiled: typeof byEpoch = [];
    for (const l of byEpoch)
      if (!tiled.some((k) => overlaps(k.replica.descriptor, l.replica.descriptor))) tiled.push(l);
    for (const id of [...leaderOf.keys()])
      if (!tiled.some((l) => l.replica.rangeId === id)) leaderOf.delete(id);
    stats.ranges = leaderOf.size;
    stats.placed = nodes.reduce(
      (n, node) => n + (node.up?.store.replicas().filter((r) => r.replicaId >= 1000n).length ?? 0),
      0,
    );
    const spans = [...leaderOf.values()]
      .map((l) => l.replica.descriptor)
      .sort((a, b) => compareBytes(a.startKey, b.startKey));
    if (!tiles(spans)) violate(`range spans do not tile the keyspace: ${describe(spans)}`);
    for (const { replica } of leaderOf.values()) {
      const s = replica.status();
      const members = [...s.confState.voters, ...s.confState.learners];
      // PD keeps every range at full strength once the faults stop (repair, drain, balance).
      if (o.pd && s.confState.voters.length < Math.min(3, o.nodes))
        violate(`range ${replica.rangeId} has only ${s.confState.voters.length} voters`);
      if (o.pd && s.confState.learners.length > 0)
        violate(`range ${replica.rangeId} still has learners ${s.confState.learners.join(',')}`);
      const hashes: string[] = [];
      for (const id of members) {
        // A member is a replica id; its node is named by the address it was added with.
        const holder = nodes.find((n) => `n${n.id}` === s.confState.addresses[id.toString()]);
        const member = holder?.up?.store.replica(replica.rangeId);
        if (!member?.initialised || member.replicaId !== id) {
          violate(`range ${replica.rangeId}: member ${id} has no replica`);
          continue;
        }
        if (member.appliedIndex !== replica.appliedIndex)
          violate(
            `range ${replica.rangeId}: replica ${id} applied ${member.appliedIndex}, leader ${replica.appliedIndex}`,
          );
        const disk = holder?.state;
        if (disk) hashes.push(await spanHash(disk, replica.descriptor));
      }
      if (new Set(hashes).size > 1) violate(`range ${replica.rangeId}: state hashes differ`);
    }
    // Final linearizable reads, on each key's leader, join the history so lost
    // acknowledged writes show up. They need Raft messages, so the world runs on.
    const invoke = world.now;
    const reads = Array.from({ length: o.keys }, (_, k) => {
      const key = `k${k}`;
      const at = live.find((u) => route(u, key)?.replica.isLeader());
      const routed = at ? route(at, key) : undefined;
      if (!at || !routed) return Promise.resolve(undefined);
      return routed.service.execute(session(at, routed.replica.rangeId, routed.service, 'final'), [
        encoder.encode('GET'),
        encoder.encode(key),
      ]);
    });
    await world.run(world.now + 5000, checkStep);
    for (const [k, reply] of (await Promise.all(reads)).entries()) {
      if (!reply) violate(`final read of k${k}: no leader holds the key`);
      else if (reply.kind.case === 'error')
        violate(`final read of k${k} failed: ${reply.kind.value.message}`);
      else
        record(`k${k}`, {
          kind: 'read',
          value: readValue(reply),
          outcome: 'ok',
          invoke,
          complete: world.now,
        });
    }
    for (const [key, ops] of history) {
      const problem = checkRegister(ops);
      if (problem) violate(`${key}: ${problem}`);
    }
    if (bank) await bankChecks(bank);
    if (memory) {
      await memory.check();
      stats.memory = { remembered: memory.committed, forgotten: memory.forgotten.size };
    }
  }

  /** After healing: resolve what is left, so nothing is in flight when the replicas are compared. */
  async function bankSettle(b: Bank): Promise<void> {
    for (let pass = 0; pass < 10; pass++) {
      const swept = b.sweep();
      await world.run(world.now + 5000, checkStep);
      await swept;
      if (b.idle && (await b.locksLeft()) === 0) break;
    }
  }

  /** No lock survives, nothing is in flight, and the total is intact (ADR-0030). */
  async function bankChecks(b: Bank): Promise<void> {
    const left = await b.locksLeft();
    if (left > 0) violate(`bank: ${left} locks survive after healing`);
    if (!b.idle) {
      const where = nodes.flatMap((n) =>
        (n.up?.store.replicas() ?? []).map((r) => {
          const st = r.status();
          return `n${n.id}/r${r.rangeId}:${st.role}@${st.term} lead ${st.lead} pending ${r.pendingProposals} frozen ${r.frozenFor} quiesced ${r.quiesced}`;
        }),
      );
      violate(
        `bank: a transaction never finished: ${[...b.pending.values()].join('; ')} | ${where.join('; ')}`,
      );
    }
    const before = b.audits;
    const audited = b.audit();
    await world.run(world.now + 5000, checkStep);
    await audited;
    if (b.audits === before) violate('bank: the final audit could not read every account');
    stats.bank = { committed: b.committed, aborted: b.aborted, audits: b.audits };
  }
}

function overlaps(a: RangeDescriptor, b: RangeDescriptor): boolean {
  const before = (end: Uint8Array, start: Uint8Array) =>
    end.length > 0 && compareBytes(end, start) <= 0;
  return !before(a.endKey, b.startKey) && !before(b.endKey, a.startKey);
}

/** True if the spans run from the start of the keyspace to its end with no gap or overlap. */
function tiles(spans: readonly RangeDescriptor[]): boolean {
  let at: Uint8Array = new Uint8Array();
  for (const d of spans) {
    if (compareBytes(d.startKey, at) !== 0) return false;
    if (d.endKey.length === 0) return d === spans.at(-1);
    at = d.endKey;
  }
  return false;
}

function describe(spans: readonly RangeDescriptor[]): string {
  const hex = (k: Uint8Array) => Buffer.from(k).toString('hex').slice(0, 16) || '∅';
  return spans.map((d) => `r${d.rangeId}[${hex(d.startKey)},${hex(d.endKey)})`).join(' ');
}

function classify(kind: RegisterOp['kind'], reply: KvReply): 'ok' | 'fail' | 'drop' | 'unknown' {
  const k = reply.kind;
  if (k.case === 'error') {
    // Refused before proposing: no effect. Anything else may have been applied.
    if (kind === 'read' || ['NOT_LEADER', 'BUSY', 'RANGE_MOVED'].includes(k.value.code))
      return 'drop';
    return 'unknown';
  }
  if (kind === 'cas' && k.case === 'null') return 'fail';
  return 'ok';
}

function readValue(reply: KvReply): string | null {
  return reply.kind.case === 'bulk' ? decoder.decode(reply.kind.value) : null;
}

/** Hash of a range's replicated keys on one node's disk. */
async function spanHash(disk: SimDisk, descriptor: RangeDescriptor): Promise<string> {
  const hash = createHash('sha256');
  const store = disk.open();
  for (const part of spanIntervals(descriptor))
    for await (const [k, v] of store.iterate(part))
      hash.update(k).update(Uint8Array.of(0)).update(v).update(Uint8Array.of(0));
  return hash.digest('hex');
}

/** Scenario DSL (PLAN 22.2): `scenario(seed).nodes(5).faults({...}).for(20_000).run()`. */
export function scenario(seed: bigint) {
  const o: { -readonly [K in keyof ScenarioOptions]: ScenarioOptions[K] } = {
    seed,
    nodes: 3,
    clients: 4,
    keys: 3,
    durationMs: 20_000,
    faults: {
      partitions: true,
      crashes: true,
      maxDrop: 0.1,
      duplicate: 0.02,
      drift: 0.05,
      splits: true,
      merges: true,
      transfers: true,
      membership: true,
      skewMs: 0,
    },
    verbose: false,
    pd: false,
    spare: 0,
    bank: 0,
    memory: 0,
  };
  const dsl = {
    pd: (spare = 0) => {
      o.pd = true;
      o.spare = spare;
      // PD decides splits, merges and placement; the random faults keep leaders moving.
      o.faults = { ...o.faults, splits: false, merges: false, membership: false };
      return dsl;
    },
    bank: (accounts = 8) => ((o.bank = accounts), dsl),
    memory: (users = 4) => ((o.memory = users), dsl),
    nodes: (n: number) => ((o.nodes = n), dsl),
    clients: (n: number) => ((o.clients = n), dsl),
    keys: (n: number) => ((o.keys = n), dsl),
    faults: (f: Partial<FaultOptions>) => ((o.faults = { ...o.faults, ...f }), dsl),
    for: (ms: number) => ((o.durationMs = ms), dsl),
    verbose: (v = true) => ((o.verbose = v), dsl),
    run: () => runScenario(o),
  };
  return dsl;
}
