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

  /** Takes one token; false when the key is out of them. */
  take(key: string, nowMs: number): boolean {
    const { burst, perSecond, maxKeys } = this.options;
    const b = this.#buckets.get(key) ?? { tokens: burst, at: nowMs };
    this.#buckets.delete(key);
    b.tokens = Math.min(burst, b.tokens + ((nowMs - b.at) / 1000) * perSecond);
    b.at = nowMs;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.#buckets.set(key, b);
    if (this.#buckets.size > maxKeys) {
      const oldest = this.#buckets.keys().next();
      if (oldest.done !== true) this.#buckets.delete(oldest.value);
    }
    return allowed;
  }
}
