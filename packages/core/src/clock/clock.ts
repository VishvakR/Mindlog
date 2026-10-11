/**
 * Time source port (PLAN 4.3). Production uses SystemClock; tests and the
 * deterministic simulator use ManualClock. Never read time any other way.
 */
export interface Clock {
  /** Wall-clock milliseconds since the Unix epoch. May jump backwards. */
  now(): bigint;
  /** Monotonic nanoseconds from an arbitrary origin; never decreases. */
  monotonic(): bigint;
}
