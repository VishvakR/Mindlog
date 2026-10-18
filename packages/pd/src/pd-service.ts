import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import type { Clock, Gauge, Logger, Metrics, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Hlc } from '@mindlog/core';
import type {
  AdminRequest,
  ClusterResponse,
  CommandSchema,
  GetRangeResponse,
  Operator,
  RangeDescriptor,
  RangeHeartbeatResponse,
  RangeStats,
  StoreHeartbeatResponse,
  StoreStats,
} from '@mindlog/proto';
import {
  ClusterResponseSchema,
  GetRangeResponseSchema,
  NodeInfoSchema,
  NodeState,
  RangeHeartbeatResponseSchema,
  StoreHeartbeatResponseSchema,
} from '@mindlog/proto';
import type { CommandStamper, Proposal } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import type {
  ClusterView,
  NodeView,
  PdConfig,
  Plan,
  RangeView,
  Scheduler,
} from './cluster-view.js';
import { DEFAULT_PD_CONFIG } from './cluster-view.js';
import { OperatorController } from './operators.js';
import { PdView } from './pd-view.js';
import { DEFAULT_SCHEDULERS } from './schedulers.js';

type Body = NonNullable<MessageInitShape<typeof CommandSchema>['body']>;

/** The PD Raft group as the service uses it (a `Replica` of range 0). */
export interface PdGroup {
  propose(command: ReturnType<CommandStamper['stamp']>): Promise<Result<Proposal, MindlogError>>;
  read(level: 'linearizable' | 'lease'): Promise<Result<void, MindlogError>>;
  isLeader(): boolean;
  status(): { readonly term: bigint; readonly lead: bigint };
}

export interface PdServiceDeps {
  readonly group: PdGroup;
  /** The PD state store (read after a read barrier). */
  readonly reader: KvReader;
  readonly clock: Clock;
  readonly stamper: CommandStamper;
  /** The node's HLC: TSO timestamps are never behind it. */
  readonly hlc: { now(): Hlc };
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly config?: PdConfig;
  readonly schedulers?: readonly Scheduler[];
  /** Cluster versions this PD binary can run (it reports its own as `binaryVersion`). */
  readonly binaryVersion?: number;
  readonly storeHeartbeatMs?: number;
  /** A node is `dead` this long after it was last heard from. */
  readonly deadAfterMs?: number;
  /** How far ahead of the clock the persisted TSO bound is kept. */
  readonly tsoWindowMs?: number;
}

const notLeader = (lead: bigint): MindlogError =>
  mindlogError('NOT_LEADER', 'this placement driver replica is not the leader', {
    retryAfterMs: 100,
    ...(lead === 0n ? {} : { fields: { leader: lead.toString() } }),
  });

interface Seen {
  stats: StoreStats;
  seenMs: number;
}

/**
 * The placement driver's logic on the PD leader (PLAN 8.3, ADR-0010).
 *
 * Replicated, through the PD Raft group: ids, node registry and lifecycle, the
 * range directory, the TSO bound, the cluster version and the operator log.
 * Soft state, rebuilt from heartbeats after a leader change: store and range
 * statistics. Schedulers wait two store-heartbeat intervals after taking over,
 * so they never decide from an empty picture.
 */
export class PdService {
  readonly #d: PdServiceDeps;
  readonly #config: PdConfig;
  readonly #view: PdView;
  readonly #controller: OperatorController;
  readonly #stores = new Map<bigint, Seen>();
  readonly #ranges = new Map<
    bigint,
    {
      view: RangeView;
      seenMs: number;
      hotSince: number | undefined;
      learner: bigint | undefined;
      learnerSince: number | undefined;
    }
  >();
  readonly #known = new Map<bigint, string>();
  readonly #plans = new Map<string, Plan>();
  readonly #gauges: { ranges: Gauge; operators: Gauge };
  #term = -1n;
  #quietUntil = 0;
  #tso = { last: 0n, bound: 0n, term: -1n };
  #tsoLock: Promise<unknown> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(deps: PdServiceDeps) {
    this.#d = deps;
    this.#config = deps.config ?? DEFAULT_PD_CONFIG;
    this.#view = new PdView(deps.reader);
    this.#controller = new OperatorController(this.#config, async (count) => {
      const first = await this.allocIds(count);
      if (!first.ok) throw new Error(first.error.message);
      return first.value;
    });
    this.#gauges = {
      ranges: deps.metrics.gauge({
        name: 'mindlog_pd_ranges_count',
        help: 'Ranges in the PD directory',
      }),
      operators: deps.metrics.gauge({
        name: 'mindlog_pd_operators_count',
        help: 'Operators in flight',
      }),
    };
  }

  /** True while this replica leads the PD group. */
  get leading(): boolean {
    return this.#d.group.isLeader();
  }

  start(intervalMs = 1000): void {
    this.#timer ??= setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // ---- replicated requests ----

  async allocIds(count: number): Promise<Result<bigint, MindlogError>> {
    return this.#propose({ case: 'pdAllocIds', value: { count } });
  }

  /** A batch of `count` timestamps; replies with the last one. Strictly increasing across leaders. */
  async tso(count: number): Promise<Result<bigint, MindlogError>> {
    const run = this.#tsoLock.then(() => this.#nextTso(BigInt(Math.max(1, count))));
    this.#tsoLock = run.catch(() => undefined);
    return run;
  }

  async #nextTso(count: bigint): Promise<Result<bigint, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    // A leader cut off from its quorum must stop issuing before a new leader starts above its
    // window: the lease read fails once the lease has run out (ADR-0007).
    const lease = await this.#d.group.read('lease');
    if (!lease.ok) return lease;
    const term = this.#d.group.status().term;
    const window = BigInt(this.#d.tsoWindowMs ?? 3000) << 16n;
    if (this.#tso.term !== term) {
      // A new leader starts above everything an old one may have issued (PD `syncTimestamp`).
      const barrier = await this.#d.group.read('linearizable');
      if (!barrier.ok) return barrier;
      const stored = await this.#view.tsoBound();
      const start = stored > this.#d.hlc.now() ? stored : this.#d.hlc.now();
      const bound = await this.#propose({ case: 'pdSetTso', value: { max: start + window } });
      if (!bound.ok) return bound;
      this.#tso = { last: start, bound: bound.value, term };
    }
    const now = this.#d.hlc.now();
    let last = this.#tso.last + count;
    if (now > last) last = now;
    if (last + window / 2n > this.#tso.bound || last >= this.#tso.bound) {
      const bound = await this.#propose({ case: 'pdSetTso', value: { max: last + window } });
      if (!bound.ok) return bound;
      this.#tso.bound = bound.value;
    }
    if (this.#d.group.status().term !== term) return err(notLeader(0n));
    this.#tso.last = last;
    return ok(last);
  }

  // ---- directory reads ----

  async getRange(key: Uint8Array): Promise<Result<GetRangeResponse, MindlogError>> {
    const ready = await this.#readable();
    if (!ready.ok) return ready;
    const range = await this.#view.rangeFor(key);
    if (!range) return err(mindlogError('NOT_FOUND', 'no range holds that key'));
    return ok(
      create(GetRangeResponseSchema, {
        range,
        leaderReplicaId: this.#ranges.get(range.rangeId)?.view.leaderReplicaId ?? 0n,
      }),
    );
  }

  async scanRanges(
    start: Uint8Array,
    limit: number,
  ): Promise<Result<RangeDescriptor[], MindlogError>> {
    const ready = await this.#readable();
    if (!ready.ok) return ready;
    const all = (await this.#view.ranges()).filter(
      (r) => r.endKey.length === 0 || Buffer.compare(r.endKey, start) > 0,
    );
    return ok(all.slice(0, limit > 0 ? limit : all.length));
  }

  // ---- heartbeats ----

  async storeHeartbeat(stats: StoreStats): Promise<Result<StoreHeartbeatResponse, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    this.#syncTerm();
    const info = stats.node;
    if (!info || info.nodeId === 0n) return err(mindlogError('INVALID_ARGUMENT', 'no node id'));
    const now = this.#d.clock.now();
    this.#stores.set(info.nodeId, { stats, seenMs: Number(now) });
    const stored = (await this.#view.nodes()).find((n) => n.nodeId === info.nodeId);
    const state = this.#stateAfterHeartbeat(stored?.state);
    const changed =
      !stored ||
      stored.address !== info.address ||
      stored.zone !== info.zone ||
      stored.binaryVersion !== info.binaryVersion ||
      stored.state !== state;
    if (changed) {
      const put = await this.#propose({
        case: 'pdPutNode',
        value: { node: create(NodeInfoSchema, { ...info, state }) },
      });
      if (!put.ok) return put;
    }
    const nodes = await this.#view.nodes();
    return ok(
      create(StoreHeartbeatResponseSchema, {
        clusterVersion: await this.#view.clusterVersion(),
        nodes,
      }),
    );
  }

  /** A node heard from again is live, unless an operator drained or removed it on purpose. */
  #stateAfterHeartbeat(stored: NodeState | undefined): NodeState {
    if (stored === NodeState.DRAINING || stored === NodeState.DECOMMISSIONED) return stored;
    return NodeState.LIVE;
  }

  async rangeHeartbeat(stats: RangeStats): Promise<Result<RangeHeartbeatResponse, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    this.#syncTerm();
    const range = stats.range;
    if (!range) return err(mindlogError('INVALID_ARGUMENT', 'no range'));
    const now = Number(this.#d.clock.now());
    const previous = this.#ranges.get(range.rangeId);
    const hot = stats.qps >= this.#config.splitQps;
    const hotSince = hot ? (previous?.hotSince ?? now) : undefined;
    const learner = stats.learners[0];
    const learnerSince =
      learner === undefined
        ? undefined
        : previous?.learner === learner
          ? previous.learnerSince
          : now;
    const view: RangeView = {
      range,
      leaderReplicaId: stats.leaderReplicaId,
      bytes: stats.bytes,
      qps: stats.qps,
      hotForMs: hotSince === undefined ? 0 : now - hotSince,
      progress: new Map(stats.followers.map((f) => [f.replicaId, f.match])),
      applied: stats.applied,
      learnerForMs: learnerSince === undefined ? 0 : now - learnerSince,
    };
    this.#ranges.set(range.rangeId, { view, seenMs: now, hotSince, learner, learnerSince });
    const known = `${range.epoch?.version ?? 0n}/${range.epoch?.confVersion ?? 0n}/${range.replicas.length}`;
    if (this.#known.get(range.rangeId) !== known) {
      const put = await this.#propose({ case: 'pdPutRange', value: { range } });
      if (!put.ok) return put;
      this.#known.set(range.rangeId, known);
    }
    const operator = this.#controller.onHeartbeat(view, now);
    await this.#recordFinished();
    return ok(create(RangeHeartbeatResponseSchema, operator ? { operator } : {}));
  }

  // ---- scheduling ----

  /** One pass of the node lifecycle, cluster version and schedulers (every second on the leader). */
  async tick(): Promise<void> {
    if (this.#ticking || !this.#d.group.isLeader()) return;
    this.#ticking = true;
    try {
      this.#syncTerm();
      const now = Number(this.#d.clock.now());
      await this.#lifecycle(now);
      await this.#raiseClusterVersion();
      const existing = new Set((await this.#view.ranges()).map((r) => r.rangeId));
      this.#controller.sweep(existing, now);
      await this.#recordFinished();
      this.#gauges.ranges.set(existing.size);
      this.#gauges.operators.set(this.#controller.list().length);
      if (now >= this.#quietUntil) await this.#schedule(now);
    } catch (cause: unknown) {
      this.#d.logger.warn('placement driver tick failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    } finally {
      this.#ticking = false;
    }
  }

  async #lifecycle(now: number): Promise<void> {
    const hb = this.#d.storeHeartbeatMs ?? 10_000;
    const deadAfter = this.#d.deadAfterMs ?? 300_000;
    for (const node of await this.#view.nodes()) {
      const seen = this.#stores.get(node.nodeId)?.seenMs ?? this.#takeoverMs;
      const silent = now - seen;
      let state: NodeState | undefined;
      if ((node.state === NodeState.LIVE || node.state === NodeState.JOINING) && silent > 3 * hb)
        state = NodeState.SUSPECT;
      else if (node.state === NodeState.SUSPECT && silent > deadAfter) state = NodeState.DEAD;
      if (state === undefined) continue;
      this.#d.logger.warn('node state changed', { node: node.nodeId, from: node.state, to: state });
      await this.#propose({
        case: 'pdPutNode',
        value: { node: create(NodeInfoSchema, { ...node, state }) },
      });
    }
  }

  get #takeoverMs(): number {
    return this.#quietUntil - 2 * (this.#d.storeHeartbeatMs ?? 10_000);
  }

  /** Cluster version = the lowest binary version among live nodes (PLAN 19.5); it only rises. */
  async #raiseClusterVersion(): Promise<void> {
    const live = (await this.#view.nodes()).filter((n) => n.state === NodeState.LIVE);
    if (live.length === 0) return;
    const lowest = Math.min(...live.map((n) => n.binaryVersion));
    if (lowest > (await this.#view.clusterVersion()))
      await this.#propose({ case: 'pdSetVersion', value: { version: lowest } });
  }

  async #schedule(now: number): Promise<void> {
    const nodes: NodeView[] = (await this.#view.nodes()).map((info) => ({
      info,
      stats: this.#stores.get(info.nodeId)?.stats,
    }));
    const fresh = (this.#d.storeHeartbeatMs ?? 10_000) * 3;
    const ranges = [...this.#ranges.values()]
      .filter((r) => now - r.seenMs <= fresh)
      .map((r) => r.view);
    const byNode = new Map(nodes.map((n) => [n.info.nodeId, n.info] as const));
    for (const scheduler of this.#d.schedulers ?? DEFAULT_SCHEDULERS) {
      const view: ClusterView = {
        nowMs: now,
        nodes,
        ranges,
        busy: this.#controller.busy(),
        config: this.#config,
      };
      const plan = scheduler.schedule(view);
      this.#plans.set(scheduler.name, plan);
      for (const planned of plan.operators) {
        const rv = ranges.find((r) => r.range.rangeId === planned.rangeId);
        if (!rv) continue;
        const op = await this.#controller.add(planned, scheduler.name, rv, now, byNode);
        if (op) await this.#propose({ case: 'pdRecordOperator', value: { operator: op } });
      }
    }
  }

  async #recordFinished(): Promise<void> {
    for (const op of this.#controller.takeFinished()) {
      this.#d.logger.info('operator finished', {
        operator: op.id,
        range: op.rangeId,
        status: op.status,
      });
      await this.#propose({ case: 'pdRecordOperator', value: { operator: op } });
    }
  }

  // ---- dashboard and admin ----

  async cluster(): Promise<Result<ClusterResponse, MindlogError>> {
    const ready = await this.#readable();
    if (!ready.ok) return ready;
    const nodes = await this.#view.nodes();
    return ok(
      create(ClusterResponseSchema, {
        nodes,
        stores: nodes.flatMap((n) => {
          const s = this.#stores.get(n.nodeId)?.stats;
          return s ? [s] : [];
        }),
        ranges: await this.#view.ranges(),
        operators: this.#controller.list(),
        recent: (await this.#view.recentOperators()).slice(-50),
        clusterVersion: await this.#view.clusterVersion(),
      }),
    );
  }

  /** Why each scheduler did or did not act at its last run. */
  explanations(): ReadonlyMap<string, Plan> {
    return this.#plans;
  }

  async admin(request: AdminRequest): Promise<Result<string, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    const action = request.action;
    const setState = async (nodeId: bigint, state: NodeState, from: NodeState[]) => {
      const node = (await this.#view.nodes()).find((n) => n.nodeId === nodeId);
      if (!node) return err(mindlogError('NOT_FOUND', `no node ${nodeId}`));
      if (!from.includes(node.state))
        return err(mindlogError('CONFLICT', `node ${nodeId} is ${NodeState[node.state]}`));
      const put = await this.#propose({
        case: 'pdPutNode',
        value: { node: create(NodeInfoSchema, { ...node, state }) },
      });
      return put.ok ? ok(`node ${nodeId} is now ${NodeState[state]}`) : put;
    };
    switch (action.case) {
      case 'drainNode':
        return setState(action.value, NodeState.DRAINING, [NodeState.LIVE, NodeState.SUSPECT]);
      case 'undrainNode':
        return setState(action.value, NodeState.LIVE, [NodeState.DRAINING]);
      case 'removeNode':
        return setState(action.value, NodeState.DECOMMISSIONED, [
          NodeState.DRAINING,
          NodeState.DEAD,
        ]);
      case 'transferLeader': {
        const rv = this.#ranges.get(action.value.rangeId)?.view;
        if (!rv) return err(mindlogError('NOT_FOUND', `no range ${action.value.rangeId}`));
        const op = await this.#operator(
          rv,
          'admin',
          `transfer leadership of range ${rv.range.rangeId} to replica ${action.value.replicaId}`,
          [{ kind: 'transfer-leader', replicaId: action.value.replicaId }],
        );
        return op.ok ? ok(`operator ${op.value.id} started`) : op;
      }
      case 'split': {
        const rv = this.#ranges.get(action.value.rangeId)?.view;
        if (!rv) return err(mindlogError('NOT_FOUND', `no range ${action.value.rangeId}`));
        const op = await this.#operator(rv, 'admin', `split range ${rv.range.rangeId} on request`, [
          { kind: 'split', targetRange: 0n },
        ]);
        return op.ok ? ok(`operator ${op.value.id} started`) : op;
      }
      default:
        return err(mindlogError('INVALID_ARGUMENT', 'no admin action'));
    }
  }

  async #operator(
    rv: RangeView,
    scheduler: string,
    explanation: string,
    steps: Parameters<OperatorController['add']>[0]['steps'],
  ): Promise<Result<Operator, MindlogError>> {
    const nodes = new Map((await this.#view.nodes()).map((n) => [n.nodeId, n] as const));
    const op = await this.#controller.add(
      { rangeId: rv.range.rangeId, steps, explanation },
      scheduler,
      rv,
      Number(this.#d.clock.now()),
      nodes,
    );
    if (!op)
      return err(mindlogError('CONFLICT', `range ${rv.range.rangeId} already has an operator`));
    await this.#propose({ case: 'pdRecordOperator', value: { operator: op } });
    return ok(op);
  }

  // ---- plumbing ----

  /** The replicated result of a command that replies with an integer. */
  async #propose(body: Body): Promise<Result<bigint, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    const proposed = await this.#d.group.propose(this.#d.stamper.stamp('$pd', 'system:pd', body));
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case === 'error')
      return err(mindlogError('INVALID_ARGUMENT', outcome.value.message));
    return ok(
      outcome.case === 'kv' && outcome.value.kind.case === 'integer'
        ? outcome.value.kind.value
        : 0n,
    );
  }

  #leaderCheck(): Result<never, MindlogError> | undefined {
    return this.#d.group.isLeader() ? undefined : err(notLeader(this.#d.group.status().lead));
  }

  /** The leader may read its own state only after a barrier proves it still leads. */
  async #readable(): Promise<Result<void, MindlogError>> {
    const lead = this.#leaderCheck();
    if (lead) return lead;
    this.#syncTerm();
    return this.#d.group.read('lease');
  }

  /** Soft state belongs to one leadership: drop it when the term changes. */
  #syncTerm(): void {
    const term = this.#d.group.status().term;
    if (term === this.#term) return;
    this.#term = term;
    this.#stores.clear();
    this.#ranges.clear();
    this.#known.clear();
    this.#plans.clear();
    this.#quietUntil = Number(this.#d.clock.now()) + 2 * (this.#d.storeHeartbeatMs ?? 10_000);
  }
}
