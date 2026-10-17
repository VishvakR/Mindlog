import type { Clock } from '../clock/clock.js';
import type { Logger } from '../logging/logger.js';
import type { Metrics } from '../metrics/metrics.js';
import type { Hlc } from './hlc.js';
import { HybridLogicalClock, hlcPhysical } from './hlc.js';

export interface ClockSyncOptions {
  readonly clock: Clock;
  readonly maxOffsetMs: bigint;
  /** How long the node stays fenced after seeing an excessive offset. */
  readonly holdMs: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
}

/**
 * The node's HLC and its view of its peers' clocks (PLAN 8.7, ADR-0007). Every
 * node-to-node message carries the sender's HLC: `stamp()` for outgoing ones,
 * `receive()` for incoming ones. A peer whose clock is further than the
 * maximum offset from ours (ahead or behind) fences this node for `holdMs`:
 * `fenced` is true and lease reads fall back to ReadIndex. Raft safety does
 * not depend on clocks, so messages are still processed.
 */
export class ClockSync {
  readonly hlc: HybridLogicalClock;
  readonly #options: ClockSyncOptions;
  readonly #offset;
  readonly #fenced;
  #fencedUntil = 0n;

  constructor(options: ClockSyncOptions) {
    this.#options = options;
    this.hlc = new HybridLogicalClock(options.clock, { maxOffsetMs: options.maxOffsetMs });
    this.#offset = options.metrics.gauge({
      name: 'mindlog_clock_offset_seconds',
      help: "Last observed offset of a peer's clock from this node's (positive: peer ahead)",
      labelNames: ['peer'],
    });
    this.#fenced = options.metrics.gauge({
      name: 'mindlog_clock_fenced_info',
      help: '1 while this node is fenced for clock skew (lease reads use ReadIndex)',
    });
  }

  /** Timestamp for an outgoing message. */
  stamp(): Hlc {
    return this.hlc.now();
  }

  /** Merges the HLC of a message from `peer`; fences this node if the peer's clock is too far off. */
  receive(peer: string, remote: Hlc): void {
    if (remote === 0n) return;
    const now = this.#options.clock.now();
    const offset = hlcPhysical(remote) - now;
    this.#offset.set(Number(offset) / 1000, { peer });
    const merged = this.hlc.update(remote);
    const max = this.#options.maxOffsetMs;
    if (!merged.ok || offset > max || -offset > max) {
      if (!this.fenced)
        this.#options.logger.error('peer clock offset exceeds the maximum; fencing lease reads', {
          peer,
          offsetMs: offset,
          maxOffsetMs: max,
        });
      this.#fencedUntil = now + BigInt(this.#options.holdMs);
      this.#fenced.set(1);
    }
  }

  /**
   * Merges the timestamp of an applied command, so followers' clocks never lag committed
   * history. Old commands (replay) are harmless and never fence; one too far ahead is ignored.
   */
  observe(remote: Hlc): void {
    if (remote !== 0n) this.hlc.update(remote);
  }

  get fenced(): boolean {
    const fenced = this.#options.clock.now() < this.#fencedUntil;
    if (!fenced && this.#fencedUntil !== 0n) {
      this.#fencedUntil = 0n;
      this.#fenced.set(0);
    }
    return fenced;
  }
}
