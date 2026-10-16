import { createHash } from 'node:crypto';
import type { Clock } from '@mindlog/core';
import {
  HybridLogicalClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
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
import { DEFAULT_REPLICA_OPTIONS, Replica } from '@mindlog/multiraft';
import type { KvReply } from '@mindlog/proto';
import type { Session } from '@mindlog/services';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
} from '@mindlog/statemachine';
import type { RegisterOp } from './linearizability.js';
import { checkRegister } from './linearizability.js';
import { SimDisk } from './sim-disk.js';
import { SimNetwork } from './sim-network.js';
import { NodeScheduler, World } from './world.js';

export interface FaultOptions {
  readonly partitions: boolean;
  readonly crashes: boolean;
  /** Highest message loss rate the schedule may pick. */
  readonly maxDrop: number;
  readonly duplicate: number;
  /** Clock rates are drawn from [1 − drift, 1 + drift] (ADR-0007 allows 10%). */
  readonly drift: number;
}

export interface ScenarioOptions {
  readonly seed: bigint;
  readonly nodes: number;
  readonly clients: number;
  readonly keys: number;
  readonly durationMs: number;
  readonly faults: FaultOptions;
  readonly verbose: boolean;
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
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Incarnation {
  readonly scheduler: NodeScheduler;
  readonly replica: Replica;
  readonly service: KvService;
  readonly machine: StateMachine;
  readonly sessions: Map<number, Session>;
  readonly logger: MemoryLogger;
}

interface SimNode {
  readonly id: bigint;
  readonly rate: number;
  readonly log: SimDisk;
  readonly state: SimDisk;
  up: Incarnation | undefined;
  booting: boolean;
  generation: number;
}

/** A clock that reads simulated time at this node's rate. */
const simClock = (world: World, rate: number): Clock => ({
  now: () => BigInt(START_MS + Math.floor(world.now * rate)),
  monotonic: () => BigInt(Math.floor(world.now * rate * 1e6)),
});

/** Runs one seed: a cluster of real replicas under random faults, then checks it (PLAN 22.2). */
export async function runScenario(o: ScenarioOptions): Promise<SimResult> {
  const world = new World(o.seed);
  const net = new SimNetwork(world);
  const violations: string[] = [];
  const stats = { events: 0, ops: 0, unknown: 0, crashes: 0, partitions: 0 };
  const say = (line: string): void => {
    if (o.verbose) console.log(`[${world.now.toFixed(1)}ms] ${line}`);
  };
  const ids = Array.from({ length: o.nodes }, (_, i) => BigInt(i + 1));
  const bootstrap = ids.map((id) => ({ id, address: `n${id}` }));
  const nodes = ids.map((id): SimNode => ({
    id,
    rate: world.between(1 - o.faults.drift, 1 + o.faults.drift),
    log: new SimDisk(),
    state: new SimDisk(),
    up: undefined,
    booting: false,
    generation: 0,
  }));
  const registry = createKvRegistry();
  const leaders = new Map<bigint, bigint>();
  const appliedAt = new Map<bigint, string>();
  const violate = (what: string): void => {
    if (violations.length < 20) violations.push(what);
    say(`VIOLATION ${what}`);
  };

  async function boot(node: SimNode): Promise<void> {
    node.booting = true;
    const generation = ++node.generation;
    const scheduler = new NodeScheduler(world, node.rate);
    const clock = simClock(world, node.rate);
    const logger = new MemoryLogger('info');
    const metrics = new MemoryMetrics();
    const handlers = new ApplyHandlerRegistry();
    for (const h of [
      kvWriteHandler(registry),
      kvBatchHandler(registry),
      expireHandler,
      gcThresholdHandler,
    ])
      handlers.register(h);
    const events = new InMemoryEventBus({ logger, metrics });
    const stateStore = node.state.open();
    const machine = await StateMachine.open({
      store: stateStore,
      handlers,
      events,
      clock,
      logger,
      metrics,
    });
    events.subscribe('CommandApplied', (e) => {
      // State machine safety: one command per index, on every replica (PLAN 7.5).
      const id = Buffer.from(e.command.requestId).toString('hex');
      const seen = appliedAt.get(e.index);
      if (seen === undefined) appliedAt.set(e.index, id);
      else if (seen !== id)
        violate(`n${node.id} applied ${id} at ${e.index}, others applied ${seen}`);
    });
    const replica = await Replica.open({
      rangeId: 1n,
      raftId: node.id,
      options: SIM_OPTIONS,
      log: new RaftLogStore(node.log.open()),
      machine,
      transport: net.transport(node.id),
      scheduler,
      clock,
      random: new SeededRandom(o.seed * 7919n + node.id * 104_729n + BigInt(generation)),
      logger,
      metrics,
      bootstrap,
    });
    const service = new KvService({
      registry,
      store: stateStore,
      proposer: replica,
      readBarrier: replica,
      stamper: new CommandStamper(
        new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
        new UlidGenerator(
          clock,
          new SeededRandom(o.seed * 31n + node.id * 1000n + BigInt(generation)),
        ),
      ),
      clock,
      authenticator: new StaticAuthenticator(undefined),
      metrics,
      tracer: {
        withSpan: (_name, _attrs, fn) => fn({ setAttribute: () => {} }),
      },
    });
    if (generation !== node.generation) return;
    replica.start();
    node.up = { scheduler, replica, service, machine, sessions: new Map(), logger };
    node.booting = false;
    say(`n${node.id} up`);
  }

  async function crash(node: SimNode, powerLoss: boolean): Promise<void> {
    if (!node.up) return;
    node.up.scheduler.alive = false;
    node.up = undefined;
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
    for (const node of nodes) {
      const up = node.up;
      if (!up) continue;
      const s = up.replica.status();
      if (s.applied > s.commit || s.commit > s.lastIndex)
        violate(`n${node.id}: applied ${s.applied} commit ${s.commit} last ${s.lastIndex}`);
      if (s.role !== 'leader') continue;
      const known = leaders.get(s.term);
      if (known === undefined) leaders.set(s.term, node.id);
      else if (known !== node.id)
        violate(`two leaders in term ${s.term}: n${known} and n${node.id}`);
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
      let session = up.sessions.get(c);
      if (!session) {
        session = up.service.openSession(`client-${c}`);
        up.sessions.set(c, session);
      }
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
      void up.service
        .execute(
          session,
          argv.map((a) => encoder.encode(a)),
        )
        .then(
          (reply) => {
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
  function scheduleFault(): void {
    world.at(world.now + world.between(500, 3000), () => {
      if (!faultsOn) return;
      const roll = world.random.next();
      if (o.faults.partitions && roll < 0.3) {
        const shuffled = [...ids].sort(() => world.random.next() - 0.5);
        const cut = 1 + Math.floor(world.between(0, ids.length - 1));
        net.partition([shuffled.slice(0, cut), shuffled.slice(cut)]);
        stats.partitions++;
        say(`partition ${shuffled.slice(0, cut).join(',')} | ${shuffled.slice(cut).join(',')}`);
      } else if (roll < 0.5) {
        net.heal();
        say('heal');
      } else if (o.faults.crashes && roll < 0.75) {
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

  // ---- run ----
  for (const node of nodes) world.at(0, () => void boot(node));
  for (let c = 0; c < o.clients; c++) client(c);
  if (o.faults.partitions || o.faults.crashes || o.faults.maxDrop > 0) scheduleFault();
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
    const fmt = (v: unknown): string =>
      JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x));
    for (const node of nodes) {
      const s = node.up?.replica.status();
      if (s) console.log(`n${node.id} status`, fmt({ ...s, confState: undefined }));
    }
    for (const node of nodes) {
      for (const e of node.up?.logger.entries.slice(-30) ?? [])
        console.log(`n${node.id}`, e.level, e.message);
    }
  }
  return { seed: o.seed, violations, stats };

  async function finalChecks(): Promise<void> {
    const up = nodes.map((n) => n.up);
    if (up.some((u) => !u)) {
      violate('a node did not come back up');
      return;
    }
    const live = up as Incarnation[];
    const applied = live.map((u) => u.machine.appliedIndex);
    if (!live.some((u) => u.replica.isLeader())) violate('no leader after healing (liveness)');
    if (new Set(applied).size !== 1)
      violate(`replicas did not converge: applied ${applied.join(', ')}`);
    for (const node of nodes) {
      const failure: unknown = node.up?.replica.failure;
      if (failure !== undefined)
        violate(`n${node.id} stopped: ${failure instanceof Error ? failure.message : 'failure'}`);
    }
    // Final linearizable reads join the history, so lost acknowledged writes show up.
    // The reads need Raft messages (ReadIndex), so the world keeps running while they finish.
    const reader = live[0] as Incarnation;
    const session = reader.service.openSession('final');
    const invoke = world.now;
    const reads = Array.from({ length: o.keys }, (_, k) =>
      reader.service.execute(session, [encoder.encode('GET'), encoder.encode(`k${k}`)]),
    );
    await world.run(world.now + 5000, checkStep);
    for (const [k, reply] of (await Promise.all(reads)).entries()) {
      if (reply.kind.case === 'error')
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
    const hashes = await Promise.all(nodes.map((n) => stateHash(n.state)));
    if (new Set(hashes).size !== 1) violate('state hashes differ after convergence');
    for (const [key, ops] of history) {
      const problem = checkRegister(ops);
      if (problem) violate(`${key}: ${problem}`);
    }
  }
}

function classify(kind: RegisterOp['kind'], reply: KvReply): 'ok' | 'fail' | 'drop' | 'unknown' {
  const k = reply.kind;
  if (k.case === 'error') {
    // Refused before proposing: no effect. Anything else may have been applied.
    if (kind === 'read' || ['NOT_LEADER', 'BUSY'].includes(k.value.code)) return 'drop';
    return 'unknown';
  }
  if (kind === 'cas' && k.case === 'null') return 'fail';
  return 'ok';
}

function readValue(reply: KvReply): string | null {
  return reply.kind.case === 'bulk' ? decoder.decode(reply.kind.value) : null;
}

async function stateHash(disk: SimDisk): Promise<string> {
  const hash = createHash('sha256');
  for await (const [k, v] of disk
    .open()
    .iterate({ start: new Uint8Array(), end: Uint8Array.of(0xff) }))
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
    faults: { partitions: true, crashes: true, maxDrop: 0.1, duplicate: 0.02, drift: 0.05 },
    verbose: false,
  };
  const dsl = {
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
