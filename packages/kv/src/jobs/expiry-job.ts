import type { Clock, Counter, Logger, Metrics } from '@mindlog/core';
import { decodeKey } from '@mindlog/core';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { expiryIndexPrefix } from '../model/kv-keys.js';

export interface ExpiryJobDeps {
  readonly store: KvReader;
  readonly proposer: Proposer;
  /** Runs only while this returns true (the range leader); always when absent. */
  readonly active?: () => boolean;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Most keys proposed per run (default 200). */
  readonly batchSize?: number;
}

interface Due {
  readonly key: Uint8Array;
  readonly expireAtMs: bigint;
}

/**
 * Leader-only active expiry (PLAN 5.2). Reads the time-ordered expiry index
 * and proposes `Expire` commands for keys that are due, so expiry is decided
 * once and replicated, never decided by each replica (CLAUDE.md rule 8).
 */
export class ExpiryJob {
  readonly #deps: ExpiryJobDeps;
  readonly #proposed: Counter;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  constructor(deps: ExpiryJobDeps) {
    this.#deps = deps;
    this.#proposed = deps.metrics.counter({
      name: 'mindlog_kv_expiry_proposed_total',
      help: 'Keys proposed for expiry by the active expiry job',
    });
  }

  /** One pass: proposes due keys, grouped by tenant. Returns how many were proposed. */
  async runOnce(): Promise<number> {
    if (this.#deps.active && !this.#deps.active()) return 0;
    const now = this.#deps.clock.now();
    const limit = this.#deps.batchSize ?? 200;
    const byTenant = new Map<string, Due[]>();
    let count = 0;
    for await (const entry of new MvccReader(this.#deps.store).scan(expiryIndexPrefix())) {
      const decoded = decodeKey(entry.key);
      if (!decoded.ok) continue;
      const [, atMs, tenant, key] = decoded.value.tuple;
      if (typeof atMs !== 'bigint' || typeof tenant !== 'string' || !(key instanceof Uint8Array))
        continue;
      if (atMs >= now || count >= limit) break;
      const due = byTenant.get(tenant) ?? [];
      due.push({ key, expireAtMs: atMs });
      byTenant.set(tenant, due);
      count++;
    }
    for (const [tenant, keys] of byTenant) {
      const command = this.#deps.stamper.stamp(tenant, 'system:expiry', {
        case: 'expire',
        value: { keys },
      });
      const proposed = await this.#deps.proposer.propose(command);
      if (proposed.ok) this.#proposed.inc(keys.length);
      else
        this.#deps.logger.warn('expiry proposal failed', { tenant, error: proposed.error.message });
    }
    return count;
  }

  /** Runs every `intervalMs`, never overlapping. */
  start(intervalMs = 100): void {
    this.#timer ??= setInterval(() => {
      this.#running ??= this.runOnce().finally(() => {
        this.#running = undefined;
      });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
