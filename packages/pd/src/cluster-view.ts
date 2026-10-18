import type { NodeInfo, RangeDescriptor, StoreStats } from '@mindlog/proto';

/** PD tunables (`pd.*` and `ranges.*` config). */
export interface PdConfig {
  /** Replicas per range. */
  readonly replicas: number;
  readonly maxBytes: bigint;
  readonly mergeBelowBytes: bigint;
  /** Queries per second a range must sustain to be split for load. */
  readonly splitQps: number;
  readonly splitQpsWindowMs: number;
  /** Operators run at once across the cluster. */
  readonly maxOperators: number;
  /** An operator that has not finished in this time is cancelled. */
  readonly operatorTimeoutMs: number;
  /** A learner this far behind after this long is removed rather than waited for. */
  readonly learnerTimeoutMs: number;
}

export const DEFAULT_PD_CONFIG: PdConfig = {
  replicas: 3,
  maxBytes: 64n * 1024n * 1024n,
  mergeBelowBytes: 16n * 1024n * 1024n,
  splitQps: 2500,
  splitQpsWindowMs: 60_000,
  maxOperators: 4,
  operatorTimeoutMs: 600_000,
  learnerTimeoutMs: 120_000,
};

export interface NodeView {
  readonly info: NodeInfo;
  readonly stats: StoreStats | undefined;
}

/** What the leader's range heartbeat last said about a range. */
export interface RangeView {
  /** The descriptor with `replicas` filled in from the leader's membership. */
  readonly range: RangeDescriptor;
  readonly leaderReplicaId: bigint;
  readonly bytes: bigint;
  readonly qps: number;
  /** How long the range has been above `splitQps`, in ms. */
  readonly hotForMs: number;
  /** Replica id → how much of the log it has. */
  readonly progress: ReadonlyMap<bigint, bigint>;
  /** The leader's applied index. */
  readonly applied: bigint;
  /** How long the oldest learner of the range has been a learner, in ms (0 without one). */
  readonly learnerForMs: number;
}

export interface ClusterView {
  readonly nowMs: number;
  readonly nodes: readonly NodeView[];
  readonly ranges: readonly RangeView[];
  /** Ranges that already have an operator. */
  readonly busy: ReadonlySet<bigint>;
  readonly config: PdConfig;
}

/** One step wanted by a scheduler; ids of new replicas and ranges are 0 until PD allocates them. */
export interface PlannedStep {
  readonly kind: 'add-learner' | 'promote' | 'transfer-leader' | 'remove-voter' | 'split' | 'merge';
  readonly nodeId?: bigint;
  /** The replica the step is about; 0 stands for the replica created by the plan's add-learner. */
  readonly replicaId?: bigint;
  readonly targetRange?: bigint;
}

export interface PlannedOperator {
  readonly rangeId: bigint;
  readonly steps: readonly PlannedStep[];
  readonly explanation: string;
}

/** What a scheduler run decided, or why it did nothing (shown on the dashboard). */
export interface Plan {
  readonly scheduler: string;
  readonly operators: readonly PlannedOperator[];
  readonly explanation: string;
}

export interface Scheduler {
  readonly name: string;
  schedule(view: ClusterView): Plan;
}
