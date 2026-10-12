import type { KeyRange } from '@mindlog/core';
import { compareBytes } from './compare-bytes.js';
import type {
  Entry,
  IterateOptions,
  KvReader,
  KvStore,
  StoreSnapshot,
  WriteBatch,
} from './kv-store.js';

interface Row {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

type Op =
  | { readonly kind: 'put'; readonly key: Uint8Array; readonly value: Uint8Array }
  | {
      readonly kind: 'del';
      readonly key: Uint8Array;
    };

/** Index of the first row whose key is >= `key`. */
function lowerBound(rows: readonly Row[], key: Uint8Array): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareBytes(rows[mid]?.key ?? key, key) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Rows in range order, copied as they are yielded. */
function* scanRows(
  rows: readonly Row[],
  range: KeyRange,
  options: IterateOptions,
): Generator<Entry, undefined> {
  const from = lowerBound(rows, range.start);
  const to = lowerBound(rows, range.end);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const step = options.reverse ? -1 : 1;
  let yielded = 0;
  for (let i = options.reverse ? to - 1 : from; i >= from && i < to && yielded < limit; i += step) {
    const row = rows[i];
    if (row) {
      yielded++;
      yield [row.key.slice(), row.value.slice()] as const;
    }
  }
  return undefined;
}

/** Reader over one immutable version of the rows. */
class RowsReader implements KvReader {
  constructor(protected readonly rowsOf: () => readonly Row[]) {}

  get(key: Uint8Array): Promise<Uint8Array | undefined> {
    const rows = this.rowsOf();
    const row = rows[lowerBound(rows, key)];
    const found = row && compareBytes(row.key, key) === 0 ? row.value.slice() : undefined;
    return Promise.resolve(found);
  }

  iterate(range: KeyRange, options: IterateOptions = {}): AsyncIterable<Entry> {
    const entries = scanRows(this.rowsOf(), range, options);
    return {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve(entries.next()) }),
    };
  }
}

/**
 * In-memory KvStore for tests and the simulator. Rows are an immutable sorted
 * array replaced on every batch, so snapshots and running iterations keep a
 * consistent view for free.
 */
export class MemoryStore extends RowsReader implements KvStore {
  #rows: readonly Row[] = [];
  #closed = false;

  constructor() {
    super(() => this.#rows);
  }

  batch(): WriteBatch {
    const ops: Op[] = [];
    return {
      put: (key, value) => {
        ops.push({ kind: 'put', key: key.slice(), value: value.slice() });
      },
      del: (key) => {
        ops.push({ kind: 'del', key: key.slice() });
      },
      get length() {
        return ops.length;
      },
      write: () => {
        if (this.#closed) return Promise.reject(new Error('MemoryStore is closed'));
        this.#rows = applyOps(this.#rows, ops);
        return Promise.resolve();
      },
    };
  }

  snapshot(): Promise<StoreSnapshot> {
    const rows = this.#rows;
    const reader = new RowsReader(() => rows);
    return Promise.resolve({
      get: (key) => reader.get(key),
      iterate: (range, options) => reader.iterate(range, options),
      release: () => Promise.resolve(),
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

function applyOps(rows: readonly Row[], ops: readonly Op[]): Row[] {
  const next = [...rows];
  for (const op of ops) {
    const at = lowerBound(next, op.key);
    const exists = next[at] !== undefined && compareBytes(next[at].key, op.key) === 0;
    if (op.kind === 'put') {
      if (exists) next[at] = { key: op.key, value: op.value };
      else next.splice(at, 0, { key: op.key, value: op.value });
    } else if (exists) {
      next.splice(at, 1);
    }
  }
  return next;
}
