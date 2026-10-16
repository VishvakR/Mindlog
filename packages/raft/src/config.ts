import type { Random } from '@mindlog/core';

/** Tunables of one Raft group (PLAN 7.4, Appendix B `raft.*`). Times are in ticks. */
export interface RaftOptions {
  /** Election timeout is drawn uniformly from [min, max). */
  readonly electionTicks: readonly [number, number];
  readonly heartbeatTicks: number;
  /** Must be below electionTicks[0] (ADR-0007). */
  readonly leaseTicks: number;
  readonly checkQuorum: boolean;
  readonly preVote: boolean;
  readonly maxInflightMsgs: number;
  /** 0 disables the byte limit. */
  readonly maxInflightBytes: number;
  /** Most entry bytes in one append message; at least one entry is always sent. */
  readonly maxEntryBatchBytes: number;
}

export const DEFAULT_RAFT_OPTIONS: RaftOptions = {
  electionTicks: [10, 20],
  heartbeatTicks: 1,
  leaseTicks: 9,
  checkQuorum: true,
  preVote: true,
  maxInflightMsgs: 256,
  maxInflightBytes: 16 * 1024 * 1024,
  maxEntryBatchBytes: 1024 * 1024,
};

export interface RaftConfig extends RaftOptions {
  /** This node; non-zero and never reused (ADR-0006). */
  readonly id: bigint;
  readonly rangeId: bigint;
  /** Election jitter; seeded per node in the simulator. */
  readonly random: Random;
}

/** Rejects option combinations that break safety or liveness. */
export function validateRaftOptions(options: RaftOptions): string | undefined {
  const [min, max] = options.electionTicks;
  if (!(min >= 1 && max > min)) return 'electionTicks must be [min, max) with 1 <= min < max';
  if (options.heartbeatTicks < 1 || options.heartbeatTicks >= min)
    return 'heartbeatTicks must be at least 1 and below electionTicks[0]';
  if (options.leaseTicks >= min) return 'leaseTicks must be below electionTicks[0] (ADR-0007)';
  if (options.maxInflightMsgs < 1) return 'maxInflightMsgs must be at least 1';
  return undefined;
}
