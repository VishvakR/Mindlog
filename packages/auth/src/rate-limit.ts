export interface BucketLimits {
  readonly burst: number;
  readonly perSecond: number;
}

/**
 * Token buckets per client key (an IP address), bounded: the least recently
 * seen keys are dropped first. Used on the auth endpoints (PLAN 16.4).
 */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly options: {
      readonly burst: number;
      readonly perSecond: number;
      readonly maxKeys: number;
    },
  ) {}

  /** Refills the key's bucket to now and moves it to the most-recent end. */
  #refill(key: string, nowMs: number, limits: BucketLimits) {
    const { burst, perSecond } = limits;
    const b = this.#buckets.get(key) ?? { tokens: burst, at: nowMs };
    this.#buckets.delete(key);
    b.tokens = Math.min(burst, b.tokens + ((nowMs - b.at) / 1000) * perSecond);
    b.at = nowMs;
    this.#buckets.set(key, b);
    if (this.#buckets.size > this.options.maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done !== true) this.#buckets.delete(oldest.value);
    }
    return b;
  }

  /** Takes one token; false when the key is out of them. `limits` overrides the defaults. */
  take(key: string, nowMs: number, limits: BucketLimits = this.options): boolean {
    const b = this.#refill(key, nowMs, limits);
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    return allowed;
  }

  /** Whether the bucket has anything left, without taking from it. */
  peek(key: string, nowMs: number, limits: BucketLimits = this.options): boolean {
    return this.#refill(key, nowMs, limits).tokens > 0;
  }

  /** Subtracts a cost known only afterwards; the bucket may go negative. */
  charge(key: string, nowMs: number, limits: BucketLimits, cost: number): void {
    this.#refill(key, nowMs, limits).tokens -= cost;
  }
}
