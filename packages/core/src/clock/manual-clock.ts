import type { Clock } from './clock.js';

const NS_PER_MS = 1_000_000n;

/**
 * Clock that only moves when told to, for tests and simulation. Wall time can
 * be set backwards to model clock skew; monotonic time only ever advances.
 */
export class ManualClock implements Clock {
  #wallMs: bigint;
  #monoNs = 0n;

  constructor(startMs = 0n) {
    this.#wallMs = startMs;
  }

  now(): bigint {
    return this.#wallMs;
  }

  monotonic(): bigint {
    return this.#monoNs;
  }

  /** Moves both wall and monotonic time forward. */
  advance(ms: bigint): void {
    if (ms < 0n) throw new RangeError('advance() takes a non-negative duration');
    this.#wallMs += ms;
    this.#monoNs += ms * NS_PER_MS;
  }

  /** Sets wall time only (may go backwards); monotonic time is unaffected. */
  setWall(ms: bigint): void {
    this.#wallMs = ms;
  }
}
