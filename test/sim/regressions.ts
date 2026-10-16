/** Seeds that once failed, kept as regression tests (PLAN 22.1). */
export const REGRESSION_SEEDS: readonly bigint[] = [
  // A follower's lost appends filled the leader's inflight window forever (fixed in step-leader).
  1229n,
  4039n,
  5313n,
  7115n,
  9139n,
];
