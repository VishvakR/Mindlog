/**
 * A bounded single-consumer queue exposed as an async iterable: the body of
 * one long-lived client stream. `push` returns false when full (the caller
 * drops the item; Raft retries).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #max: number;
  #items: T[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  constructor(max: number) {
    this.#max = max;
  }

  push(item: T): boolean {
    if (this.#closed || this.#items.length >= this.#max) return false;
    this.#items.push(item);
    this.#wake?.();
    return true;
  }

  close(): void {
    this.#closed = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#closed) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}
