/**
 * Model time per tenant per hour for background work (PLAN 12.6), as a
 * token bucket refilled continuously.
 * shortcut: node-local, so a leader change starts a full bucket; replicate it if tenants abuse that.
 */
export class ModelBudget {
  readonly #perHourMs: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, { left: number; at: number }>();

  /** `secondsPerHour` 0 turns the budget off (no limit). */
  constructor(secondsPerHour: number, now: () => number) {
    this.#perHourMs = secondsPerHour * 1000;
    this.#now = now;
  }

  #bucket(tenant: string) {
    const now = this.#now();
    const b = this.#buckets.get(tenant) ?? { left: this.#perHourMs, at: now };
    b.left = Math.min(this.#perHourMs, b.left + ((now - b.at) * this.#perHourMs) / 3_600_000);
    b.at = now;
    this.#buckets.set(tenant, b);
    return b;
  }

  /** Whether the tenant has model time left. */
  available(tenant: string): boolean {
    return this.#perHourMs === 0 || this.#bucket(tenant).left > 0;
  }

  /** Records model time used; the bucket may go negative, delaying the next run. */
  spend(tenant: string, ms: number): void {
    if (this.#perHourMs === 0) return;
    this.#bucket(tenant).left -= ms;
  }

  /** Milliseconds until the tenant has model time again (0 when it has). */
  waitMs(tenant: string): number {
    if (this.#perHourMs === 0) return 0;
    const left = this.#bucket(tenant).left;
    return left > 0 ? 0 : Math.ceil((-left + 1) * (3_600_000 / this.#perHourMs));
  }
}
