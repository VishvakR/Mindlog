import type { Clock, Logger, Metrics } from '@mindlog/core';
import { ExpiryJob, GcJob } from '@mindlog/kv';
import type { Store } from '@mindlog/multiraft';
import type { CommandStamper } from '@mindlog/statemachine';
import type { HeldLock } from '@mindlog/txn';
import { LockResolverJob } from '@mindlog/txn';
import type { KvReader } from '@mindlog/storage';

export interface RangeJobsDeps {
  readonly store: Store;
  readonly state: KvReader;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  /** Resolves a stopped transaction's lock; present when cross-range transactions are on. */
  readonly resolve?: (held: HeldLock) => Promise<unknown>;
  /** How often the set of local ranges is checked (default 1 s). */
  readonly syncMs?: number;
}

/**
 * Expiry and GC are replicated commands proposed by each range's leader
 * (CLAUDE.md rule 8). Ranges split and move, so this keeps one pair of jobs per
 * range this node holds a replica of; they only act while it leads.
 */
export class RangeJobs {
  readonly #d: RangeJobsDeps;
  readonly #jobs = new Map<bigint, { expiry: ExpiryJob; gc: GcJob; locks?: LockResolverJob }>();
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: RangeJobsDeps) {
    this.#d = deps;
  }

  start(): void {
    this.sync();
    this.#timer = setInterval(() => {
      this.sync();
    }, this.#d.syncMs ?? 1000);
    this.#timer.unref();
  }

  /** Starts jobs for new local ranges and stops those of ranges that are gone. */
  sync(): void {
    const live = new Map(this.#d.store.replicas().map((r) => [r.rangeId, r] as const));
    for (const [rangeId, jobs] of this.#jobs) {
      if (live.has(rangeId)) continue;
      this.#jobs.delete(rangeId);
      void Promise.all([
        jobs.expiry.stop(),
        jobs.gc.stop(),
        jobs.locks?.stop() ?? Promise.resolve(),
      ]);
    }
    for (const [rangeId, replica] of live) {
      if (this.#jobs.has(rangeId)) continue;
      const common = {
        proposer: replica,
        active: () => replica.initialised && replica.isLeader(),
        stamper: this.#d.stamper,
        clock: this.#d.clock,
        logger: this.#d.logger,
        metrics: this.#d.metrics,
      };
      const expiry = new ExpiryJob({ ...common, store: this.#d.state, rangeId });
      const gc = new GcJob({ ...common, appliedIndex: () => replica.appliedIndex });
      const resolve = this.#d.resolve;
      const locks = resolve
        ? new LockResolverJob({
            state: this.#d.state,
            rangeId,
            active: common.active,
            clock: this.#d.clock,
            logger: this.#d.logger,
            resolve,
          })
        : undefined;
      expiry.start();
      gc.start();
      locks?.start();
      this.#jobs.set(rangeId, { expiry, gc, ...(locks ? { locks } : {}) });
    }
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    const all = [...this.#jobs.values()];
    this.#jobs.clear();
    await Promise.all(
      all.flatMap((j) => [j.expiry.stop(), j.gc.stop(), j.locks?.stop() ?? Promise.resolve()]),
    );
  }
}
