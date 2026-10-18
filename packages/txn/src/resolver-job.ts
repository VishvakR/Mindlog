import type { Clock, Logger } from '@mindlog/core';
import type { KvReader } from '@mindlog/storage';
import type { HeldLock } from './scan-locks.js';
import { scanLocks } from './scan-locks.js';

export interface LockResolverDeps {
  /** The node's whole state store. */
  readonly state: KvReader;
  readonly rangeId: bigint;
  /** Runs only while this returns true (the range leader). */
  readonly active: () => boolean;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Rolls a lock's transaction forward or back. */
  readonly resolve: (held: HeldLock) => Promise<unknown>;
}

/**
 * Clears the locks of transactions that stopped (ADR-0030): on the range
 * leader, every lock past its TTL is resolved through its primary.
 */
export class LockResolverJob {
  readonly #d: LockResolverDeps;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  constructor(deps: LockResolverDeps) {
    this.#d = deps;
  }

  /** One pass; returns how many locks it tried to resolve. */
  async runOnce(): Promise<number> {
    if (!this.#d.active()) return 0;
    const now = this.#d.clock.now();
    let tried = 0;
    for (const held of await scanLocks(this.#d.state, this.#d.rangeId)) {
      if (held.lock.lockedAtMs + held.lock.ttlMs > now) continue;
      tried++;
      try {
        await this.#d.resolve(held);
      } catch (cause: unknown) {
        this.#d.logger.warn('lock resolution failed', {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    return tried;
  }

  start(intervalMs = 5_000): void {
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
