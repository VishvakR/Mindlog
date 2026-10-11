import type { Clock } from './clock.js';

/** Clock backed by the host: `Date.now()` and `process.hrtime.bigint()`. */
export class SystemClock implements Clock {
  now(): bigint {
    return BigInt(Date.now());
  }

  monotonic(): bigint {
    return process.hrtime.bigint();
  }
}
