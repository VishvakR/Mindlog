import type { KvReader, WriteBatch } from '../store/kv-store.js';
import { compareBytes } from '../store/compare-bytes.js';
import type { MvccScanOptions, VersionedValue } from './mvcc-reader.js';
import { MvccReader } from './mvcc-reader.js';
import { MvccWriter } from './mvcc-writer.js';
import { keyAfter } from './versioned-key.js';

interface Pending {
  readonly key: Uint8Array;
  /** `null` marks a delete. */
  readonly value: Uint8Array | null;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean =>
  key.length >= prefix.length && prefix.every((b, i) => key[i] === b);

/**
 * Read-your-writes view for one apply: reads see the latest committed state
 * plus this transaction's own pending puts and deletes; `writeTo` turns the
 * pending set into MVCC versions at the transaction's index.
 */
export class MvccTxn {
  readonly #reader: MvccReader;
  readonly #index: bigint;
  readonly #pending = new Map<string, Pending>();

  constructor(reader: KvReader, index: bigint) {
    this.#reader = new MvccReader(reader);
    this.#index = index;
  }

  get index(): bigint {
    return this.#index;
  }

  /** Number of keys written so far. */
  get size(): number {
    return this.#pending.size;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    const pending = this.#pending.get(hex(key));
    if (pending) return pending.value ?? undefined;
    return this.#reader.get(key);
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.#pending.set(hex(key), { key: key.slice(), value: value.slice() });
  }

  delete(key: Uint8Array): void {
    this.#pending.set(hex(key), { key: key.slice(), value: null });
  }

  /** Committed entries merged with pending ones (pending wins, deletes hide). */
  async *scan(prefix: Uint8Array, options: MvccScanOptions = {}): AsyncGenerator<VersionedValue> {
    const reverse = options.reverse ?? false;
    const order = reverse ? -1 : 1;
    const overlay = [...this.#pending.values()]
      .filter((p) => startsWith(p.key, prefix))
      .filter((p) => !options.after || compareBytes(p.key, keyAfter(options.after)) >= 0)
      .filter((p) => !options.before || compareBytes(p.key, options.before) < 0)
      .sort((a, b) => order * compareBytes(a.key, b.key));
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    let emitted = 0;
    let o = 0;
    const committedOptions: MvccScanOptions = { ...options, limit: Number.POSITIVE_INFINITY };
    const emit = (p: Pending): VersionedValue | undefined =>
      p.value === null ? undefined : { key: p.key, value: p.value, index: this.#index };

    for await (const entry of this.#reader.scan(prefix, committedOptions)) {
      while (
        o < overlay.length &&
        order * compareBytes(overlay[o]?.key ?? entry.key, entry.key) < 0
      ) {
        const out = emit(overlay[o++] as Pending);
        if (out) {
          yield out;
          if (++emitted >= limit) return;
        }
      }
      const same = overlay[o] && compareBytes((overlay[o] as Pending).key, entry.key) === 0;
      const out = same ? emit(overlay[o++] as Pending) : entry;
      if (out) {
        yield out;
        if (++emitted >= limit) return;
      }
    }
    while (o < overlay.length) {
      const out = emit(overlay[o++] as Pending);
      if (out) {
        yield out;
        if (++emitted >= limit) return;
      }
    }
  }

  /** Writes every pending change as a version at this transaction's index. */
  writeTo(batch: WriteBatch): void {
    const writer = new MvccWriter(batch, this.#index);
    for (const { key, value } of this.#pending.values()) {
      if (value === null) writer.delete(key);
      else writer.put(key, value);
    }
  }
}
