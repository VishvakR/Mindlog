/** Seeds that once failed, kept as regression tests (PLAN 22.1). */
export const REGRESSION_SEEDS: readonly bigint[] = [
  // A follower's lost appends filled the leader's inflight window forever (fixed in step-leader).
  1229n,
  4039n,
  5313n,
  7115n,
  9139n,
];

/** Seeds that once failed with the memory workload (`SIM_MEM=1`). */
export const MEMORY_REGRESSION_SEEDS: readonly bigint[] = [
  // A frozen range's refusals were folded in by a merge on some replicas only (idempotency split).
  84n,
  197n,
];

/** Seeds that once failed with the semantic split workload (`SIM_SPLIT=1`). */
export const SPLIT_REGRESSION_SEEDS: readonly bigint[] = [
  // A forget missed a memory in flight: before its copy reached the target, after the source marked it.
  74n,
];
