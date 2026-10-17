import type { Clock, Counter, Logger, Metrics } from '@mindlog/core';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import { SYSTEM_TENANT, packHlc } from '@mindlog/core';

export interface GcJobDeps {
  readonly proposer: Proposer;
  /** Runs only while this returns true (the range leader); always when absent. */
  readonly active?: () => boolean;
  readonly stamper: CommandStamper;
  /** The range's applied index (the state machine's). */
  readonly appliedIndex: () => bigint;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Keep this much MVCC history, in ms of version time (default 10 min, ADR-0027). */
  readonly retainMs?: bigint;
  /** After a sweep caught up, wait for this many new entries (default 1,000). */
  readonly idleEntries?: bigint;
  /** Rows removed per GcThreshold command (default 1,000). */
  readonly limit?: number;
}

/**
 * Leader-only garbage collection (PLAN 10.2, ADR-0022). Proposes GcThreshold
 * commands while the previous one still found work, and otherwise only after
 * enough new entries were applied, so an idle range stops writing to its log.
 * Versions are HLC timestamps, so the threshold is "now minus the retention".
 */
export class GcJob {
  readonly #deps: GcJobDeps;
  readonly #removed: Counter;
  #lastIdleAt = -1n;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  constructor(deps: GcJobDeps) {
    this.#deps = deps;
    this.#removed = deps.metrics.counter({
      name: 'mindlog_kv_gc_removed_total',
      help: 'Rows reclaimed by GcThreshold commands (dead generations and old versions)',
    });
  }

  /** One GC step; returns rows removed (0 when skipped). */
  async runOnce(): Promise<number> {
    if (this.#deps.active && !this.#deps.active()) return 0;
    const applied = this.#deps.appliedIndex();
    const limit = this.#deps.limit ?? 1000;
    const idle = this.#deps.idleEntries ?? 1_000n;
    if (this.#lastIdleAt >= 0n && applied - this.#lastIdleAt < idle) return 0;
    const retainMs = this.#deps.retainMs ?? 600_000n;
    const now = this.#deps.clock.now();
    if (now <= retainMs) return 0;
    const command = this.#deps.stamper.stamp(SYSTEM_TENANT, 'system:gc', {
      case: 'gcThreshold',
      value: { belowVersion: packHlc(now - retainMs, 0n), limit },
    });
    const proposed = await this.#deps.proposer.propose(command);
    if (!proposed.ok) {
      this.#deps.logger.warn('gc proposal failed', { error: proposed.error.message });
      return 0;
    }
    const outcome = proposed.value.result.outcome;
    const removed =
      outcome.case === 'kv' && outcome.value.kind.case === 'integer'
        ? Number(outcome.value.kind.value)
        : 0;
    this.#removed.inc(removed);
    // Less than a full batch means the sweep caught up: wait for new entries.
    this.#lastIdleAt = removed < limit ? this.#deps.appliedIndex() : -1n;
    return removed;
  }

  start(intervalMs = 1_000): void {
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
