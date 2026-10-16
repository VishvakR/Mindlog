/**
 * Append messages sent to one follower and not yet acknowledged, bounded by
 * count and bytes (flow control, PLAN 7.1 "Pipelining + batching").
 */
export class Inflights {
  readonly #maxCount: number;
  readonly #maxBytes: number;
  #indexes: bigint[] = [];
  #sizes: number[] = [];
  #bytes = 0;

  constructor(maxCount: number, maxBytes: number) {
    this.#maxCount = maxCount;
    this.#maxBytes = maxBytes;
  }

  get count(): number {
    return this.#indexes.length;
  }

  get bytes(): number {
    return this.#bytes;
  }

  full(): boolean {
    return this.count >= this.#maxCount || (this.#maxBytes > 0 && this.#bytes >= this.#maxBytes);
  }

  /** Records a message whose last entry is `index`; indexes must increase. */
  add(index: bigint, bytes: number): void {
    const last = this.#indexes.at(-1);
    if (last !== undefined && index <= last) throw new Error(`inflight ${index} after ${last}`);
    this.#indexes.push(index);
    this.#sizes.push(bytes);
    this.#bytes += bytes;
  }

  /** Releases every message whose last entry is at or below `index`. */
  freeLE(index: bigint): void {
    let n = 0;
    while (n < this.#indexes.length && (this.#indexes[n] ?? 0n) <= index) {
      this.#bytes -= this.#sizes[n] ?? 0;
      n++;
    }
    if (n === 0) return;
    this.#indexes = this.#indexes.slice(n);
    this.#sizes = this.#sizes.slice(n);
  }

  reset(): void {
    this.#indexes = [];
    this.#sizes = [];
    this.#bytes = 0;
  }
}
