import type { Clock } from '../clock/clock.js';
import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';

/**
 * Hybrid logical clock timestamp (PLAN 8.7): 48-bit physical milliseconds in
 * the high bits, a 16-bit logical counter in the low bits. Ordinary bigint
 * comparison orders HLCs, and the value fits the proto `uint64 hlc` field.
 */
export type Hlc = bigint & { readonly __brand: 'Hlc' };

const LOGICAL_BITS = 16n;
const MAX_LOGICAL = (1n << LOGICAL_BITS) - 1n;
const MAX_PHYSICAL = (1n << 48n) - 1n;

export function packHlc(physicalMs: bigint, logical: bigint): Hlc {
  if (physicalMs < 0n || physicalMs > MAX_PHYSICAL) {
    throw new RangeError(`HLC physical time out of range: ${physicalMs}`);
  }
  if (logical < 0n || logical > MAX_LOGICAL) {
    throw new RangeError(`HLC logical counter out of range: ${logical}`);
  }
  return ((physicalMs << LOGICAL_BITS) | logical) as Hlc;
}

export function hlcPhysical(hlc: Hlc): bigint {
  return hlc >> LOGICAL_BITS;
}

export function hlcLogical(hlc: Hlc): bigint {
  return hlc & MAX_LOGICAL;
}

export interface HlcOptions {
  /** Remote timestamps further ahead of local wall time than this are rejected. */
  readonly maxOffsetMs: bigint;
}

/**
 * HLC from Kulkarni et al., "Logical Physical Clocks" (2014). Timestamps never
 * go backwards, stay close to wall time, and capture causality across nodes.
 */
export class HybridLogicalClock {
  readonly #clock: Clock;
  readonly #maxOffsetMs: bigint;
  #physical = 0n;
  #logical = 0n;

  constructor(clock: Clock, options: HlcOptions) {
    this.#clock = clock;
    this.#maxOffsetMs = options.maxOffsetMs;
  }

  /** Last timestamp issued or observed, without advancing the clock. */
  current(): Hlc {
    return packHlc(this.#physical, this.#logical);
  }

  /** Timestamp for a local event or an outgoing message. */
  now(): Hlc {
    const wall = this.#clock.now();
    if (wall > this.#physical) {
      this.#physical = wall;
      this.#logical = 0n;
    } else {
      this.#tick();
    }
    return this.current();
  }

  /** Merges a timestamp received from another node; rejects excessive skew. */
  update(remote: Hlc): Result<Hlc, MindlogError> {
    const wall = this.#clock.now();
    const remotePhysical = hlcPhysical(remote);
    const remoteLogical = hlcLogical(remote);
    if (remotePhysical - wall > this.#maxOffsetMs) {
      return err(
        mindlogError(
          'CLOCK_OFFSET_EXCEEDED',
          `remote clock is ${remotePhysical - wall} ms ahead (max ${this.#maxOffsetMs} ms)`,
        ),
      );
    }
    const physical = [this.#physical, remotePhysical, wall].reduce((a, b) => (a > b ? a : b));
    if (physical === this.#physical && physical === remotePhysical) {
      this.#logical = this.#logical > remoteLogical ? this.#logical : remoteLogical;
      this.#tick();
    } else if (physical === this.#physical) {
      this.#tick();
    } else if (physical === remotePhysical) {
      this.#physical = remotePhysical;
      this.#logical = remoteLogical;
      this.#tick();
    } else {
      this.#physical = physical;
      this.#logical = 0n;
    }
    return ok(this.current());
  }

  /** Increments the logical counter, carrying into physical time on overflow. */
  #tick(): void {
    if (this.#logical >= MAX_LOGICAL) {
      this.#physical += 1n;
      this.#logical = 0n;
    } else {
      this.#logical += 1n;
    }
  }
}
