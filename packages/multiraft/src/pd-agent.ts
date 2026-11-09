import { create } from '@bufbuild/protobuf';
import type { Gauge, Logger, Metrics } from '@mindlog/core';
import type { NodeInfo, Operator, TenantBudget, TenantStats } from '@mindlog/proto';
import {
  ConfChangeSchema,
  ConfChangeType,
  FollowerProgressSchema,
  NodeInfoSchema,
  NodeState,
  RangeDescriptorSchema,
  RangeStatsSchema,
  ReplicaDescriptorSchema,
  ReplicaRole,
  StepKind,
  StoreStatsSchema,
  TenantStatsSchema,
} from '@mindlog/proto';
import type { PdClient } from './pd-client.js';
import type { Scheduler } from './ports.js';
import type { Replica } from './replica.js';
import type { Store } from './store.js';

/** Split and merge commands are proposed only once every live node runs a binary that applies them (PLAN 19.5). */
const MIN_RANGE_VERSION = 4;

/** Per-tenant governance's view of the heartbeat (PLAN 18.3). */
export interface TenantReporter {
  report(): Omit<TenantStats, '$typeName' | '$unknown'>[];
  apply(budgets: readonly TenantBudget[]): void;
}

export interface PdAgentOptions {
  /** This node as PD should know it. */
  readonly node: { nodeId: bigint; address: string; zone: string; binaryVersion: number };
  readonly storeHeartbeatMs: number;
  readonly rangeHeartbeatMs: number;
  /** How often replicas without a leader are checked against PD's directory (default 30 s). */
  readonly gcIntervalMs?: number;
  readonly logger: Logger;
  /** Where the node's replica and leader counts are published (`mindlog_store_*`). */
  readonly metrics?: Metrics;
}

/**
 * The node's side of the placement driver (PLAN 8.3): reports the node and the
 * ranges it leads, and carries out the operator step PD returns for each
 * range. PD is advisory: while it is unreachable the node keeps serving with
 * what it has (PLAN 21), and every step is safe to repeat because PD decides
 * a step is done only by seeing its effect in a later heartbeat.
 */
export class PdAgent {
  readonly #store: Store;
  readonly #pd: PdClient;
  readonly #scheduler: Scheduler;
  readonly #o: PdAgentOptions;
  readonly #nodes = new Map<bigint, NodeInfo>();
  readonly #inFlight = new Set<bigint>();
  readonly #proposals = new Map<bigint, number>();
  readonly #leaderless = new Map<bigint, number>();
  readonly #stops: Array<() => void> = [];
  readonly #running = new Set<Promise<void>>();
  #clusterVersion = 0;
  readonly #gauges: { replicas: Gauge; leaders: Gauge } | undefined;
  #tenants: TenantReporter | undefined;

  constructor(store: Store, pd: PdClient, scheduler: Scheduler, options: PdAgentOptions) {
    this.#store = store;
    this.#pd = pd;
    this.#scheduler = scheduler;
    this.#o = options;
    const m = options.metrics;
    this.#gauges = m && {
      replicas: m.gauge({
        name: 'mindlog_store_replicas_count',
        help: 'Range replicas hosted on this node',
      }),
      leaders: m.gauge({
        name: 'mindlog_store_leaders_count',
        help: 'Ranges this node leads',
      }),
    };
  }

  start(): void {
    this.#stops.push(
      this.#scheduler.every(this.#o.storeHeartbeatMs, () => {
        this.#track(this.reportStore());
      }),
      this.#scheduler.every(this.#o.rangeHeartbeatMs, () => {
        this.#track(this.reportRanges());
      }),
      this.#scheduler.every(this.#o.gcIntervalMs ?? 30_000, () => {
        this.#track(this.collectZombies());
      }),
    );
  }

  /** Stops the timers and waits for reports already in flight, so the stores can close after it. */
  async stop(): Promise<void> {
    for (const stop of this.#stops.splice(0)) stop();
    await Promise.allSettled([...this.#running]);
  }

  #track(work: Promise<void>): void {
    const done = work.finally(() => this.#running.delete(done));
    this.#running.add(done);
    done.catch(() => {});
  }

  /** Nodes PD knows, by id (from the last store heartbeat reply). */
  get nodes(): ReadonlyMap<bigint, NodeInfo> {
    return this.#nodes;
  }

  /** The cluster version PD last reported; new command kinds are proposed only at or above theirs. */
  get clusterVersion(): number {
    return this.#clusterVersion;
  }

  async reportStore(): Promise<void> {
    const replicas = this.#store.replicas().filter((r) => r.initialised && r.rangeId !== 0n);
    const bytes = replicas.reduce((sum, r) => sum + r.stats().bytes, 0n);
    const stats = create(StoreStatsSchema, {
      tenants: (this.#tenants?.report() ?? []).map((t) => create(TenantStatsSchema, t)),
      node: create(NodeInfoSchema, { ...this.#o.node, state: NodeState.UNSPECIFIED }),
      usedBytes: bytes,
      rangeCount: replicas.length,
      leaderCount: replicas.filter((r) => r.isLeader()).length,
    });
    this.#gauges?.replicas.set(replicas.length);
    this.#gauges?.leaders.set(stats.leaderCount);
    const reply = await this.#pd.storeHeartbeat(stats);
    if (!reply.ok) return;
    this.#clusterVersion = reply.value.clusterVersion;
    this.#tenants?.apply(reply.value.budgets);
    this.#nodes.clear();
    for (const n of reply.value.nodes) this.#nodes.set(n.nodeId, n);
  }

  /** Connects per-tenant governance, which is built after the agent. */
  attachTenants(tenants: TenantReporter): void {
    this.#tenants = tenants;
  }

  async reportRanges(): Promise<void> {
    const seconds = this.#o.rangeHeartbeatMs / 1000;
    for (const replica of this.#store.replicas()) {
      // Range 0 is PD's own Raft group: its membership is configured, not scheduled (ADR-0010).
      if (replica.rangeId === 0n || !replica.initialised || !replica.isLeader()) continue;
      const id = replica.rangeId;
      const proposals = replica.stats().proposals;
      const qps = (proposals - (this.#proposals.get(id) ?? proposals)) / seconds;
      this.#proposals.set(id, proposals);
      const reply = await this.#pd.rangeHeartbeat(this.#statsOf(replica, qps));
      const op = reply.ok ? reply.value.operator : undefined;
      if (op && !this.#inFlight.has(id)) {
        this.#inFlight.add(id);
        void this.#execute(replica, op).finally(() => this.#inFlight.delete(id));
      }
    }
  }

  /**
   * A replica that missed its own removal hears from nobody and cannot win an election, so it
   * would linger for ever. If it has had no leader for two checks in a row and PD's entry for its
   * range (at least as new as its own view) does not list it, it is destroyed (TiKV's replica GC).
   */
  async collectZombies(): Promise<void> {
    for (const replica of this.#store.replicas()) {
      const id = replica.rangeId;
      if (id === 0n || !replica.initialised || replica.status().lead !== 0n) {
        this.#leaderless.delete(id);
        continue;
      }
      const strikes = (this.#leaderless.get(id) ?? 0) + 1;
      this.#leaderless.set(id, strikes);
      if (strikes < 2) continue;
      const found = await this.#pd.getRange(replica.descriptor.startKey);
      if (!found.ok || found.value.range.rangeId !== id) continue;
      const pd = found.value.range;
      const local = replica.descriptor.epoch;
      if ((pd.epoch?.confVersion ?? 0n) < (local?.confVersion ?? 0n)) continue;
      if (pd.replicas.length === 0 || pd.replicas.some((r) => r.replicaId === replica.replicaId))
        continue;
      this.#o.logger.warn('removing a replica that PD no longer lists', {
        range: id,
        replica: replica.replicaId,
      });
      this.#leaderless.delete(id);
      await this.#store.removeReplica(id);
    }
  }

  #statsOf(replica: Replica, qps: number) {
    const status = replica.status();
    const byAddress = new Map([...this.#nodes.values()].map((n) => [n.address, n.nodeId] as const));
    const place = (id: bigint, role: ReplicaRole) =>
      create(ReplicaDescriptorSchema, {
        replicaId: id,
        nodeId: byAddress.get(status.confState.addresses[id.toString()] ?? '') ?? 0n,
        role,
      });
    const descriptor = create(RangeDescriptorSchema, {
      ...replica.descriptor,
      replicas: [
        ...status.confState.voters.map((id) => place(id, ReplicaRole.VOTER)),
        ...status.confState.learners.map((id) => place(id, ReplicaRole.LEARNER)),
      ],
    });
    return create(RangeStatsSchema, {
      range: descriptor,
      leaderReplicaId: replica.replicaId,
      bytes: replica.stats().bytes,
      qps,
      learners: status.confState.learners,
      applied: replica.appliedIndex,
      followers: status.progress.map((p) =>
        create(FollowerProgressSchema, { replicaId: p.id, match: p.match }),
      ),
    });
  }

  async #execute(replica: Replica, op: Operator): Promise<void> {
    const step = op.steps[op.step];
    if (!step) return;
    const status = replica.status();
    const change = (type: ConfChangeType, id: bigint, address: string) =>
      replica.changeMembership(create(ConfChangeSchema, { type, nodeId: id, address }));
    const log = (outcome: string): void => {
      this.#o.logger.debug('operator step', {
        operator: op.id,
        range: replica.rangeId,
        step: StepKind[step.kind],
        outcome,
      });
    };
    try {
      switch (step.kind) {
        case StepKind.ADD_LEARNER:
          // One replica of a range per node: a stale one (PD forgot an earlier move) blocks a second.
          if (
            Object.values(status.confState.addresses).includes(step.address) &&
            !status.confState.addresses[step.replicaId.toString()]
          ) {
            log('the node already holds a replica of this range');
            return;
          }
          await change(ConfChangeType.ADD_LEARNER, step.replicaId, step.address);
          break;
        case StepKind.PROMOTE: {
          const caught = status.progress.find((p) => p.id === step.replicaId);
          // Promoting a learner that is far behind would stall commits (ADR-0006).
          if (!caught || caught.match < status.commit) {
            log('learner is catching up');
            return;
          }
          await change(
            ConfChangeType.ADD_VOTER,
            step.replicaId,
            status.confState.addresses[step.replicaId.toString()] ?? step.address,
          );
          break;
        }
        case StepKind.TRANSFER_LEADER:
          replica.transferLeader(step.replicaId);
          break;
        case StepKind.REMOVE_VOTER:
          if (step.replicaId === replica.replicaId) {
            log('the leader cannot remove itself');
            return;
          }
          await change(ConfChangeType.REMOVE_NODE, step.replicaId, '');
          break;
        case StepKind.SPLIT:
          if (this.#clusterVersion < MIN_RANGE_VERSION) {
            log('cluster version too low');
            return;
          }
          await this.#store.split(replica.rangeId, step.newRangeId);
          break;
        case StepKind.MERGE:
          if (this.#clusterVersion < MIN_RANGE_VERSION) {
            log('cluster version too low');
            return;
          }
          await this.#store.merge(step.newRangeId);
          break;
        default:
          break;
      }
      log('sent');
    } catch (cause: unknown) {
      this.#o.logger.warn('operator step failed', {
        operator: op.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
