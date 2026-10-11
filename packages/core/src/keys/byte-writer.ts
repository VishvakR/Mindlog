/** Growable byte buffer for building keys without per-element allocations. */
export class ByteWriter {
  #buf: Uint8Array;
  #length = 0;

  constructor(initialCapacity = 64) {
    this.#buf = new Uint8Array(initialCapacity);
  }

  get length(): number {
    return this.#length;
  }

  byte(value: number): void {
    this.#reserve(1);
    this.#buf[this.#length++] = value;
  }

  bytes(source: Uint8Array): void {
    this.#reserve(source.length);
    this.#buf.set(source, this.#length);
    this.#length += source.length;
  }

  /** Copy of the bytes written so far. */
  finish(): Uint8Array {
    return this.#buf.slice(0, this.#length);
  }

  #reserve(extra: number): void {
    const needed = this.#length + extra;
    if (needed <= this.#buf.length) return;
    let capacity = this.#buf.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint8Array(capacity);
    next.set(this.#buf.subarray(0, this.#length));
    this.#buf = next;
  }
}
