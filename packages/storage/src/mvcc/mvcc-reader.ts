import { TupleCode } from '@mindlog/core';
import type { KvReader } from '../store/kv-store.js';
import { compareBytes } from '../store/compare-bytes.js';
import { decodeVersionValue } from './version-value.js';
import { keyAfter, parseVersionedKey, versionedKey } from './versioned-key.js';

/** A visible value and the commit index that wrote it. */
export interface VersionedValue {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
  readonly index: bigint;
}

export interface MvccScanOptions {
  /** Read as of this commit index (default: latest). */
  readonly at?: bigint;
  readonly limit?: number;
  readonly reverse?: boolean;
  /** Start at this raw key (inclusive), e.g. the prefix of an inclusive bound. */
  readonly from?: Uint8Array;
  /** Resume strictly after this key (and anything extending it). */
  readonly after?: Uint8Array;
  /** Stop before this key (exclusive). */
  readonly before?: Uint8Array;
}

const versionStart = (logical: Uint8Array): Uint8Array => {
  const out = new Uint8Array(logical.length + 1);
  out.set(logical);
  out[logical.length] = TupleCode.VERSION;
  return out;
};

const prefixEnd = (prefix: Uint8Array): Uint8Array => {
  const out = new Uint8Array(prefix.length + 1);
  out.set(prefix);
  out[prefix.length] = 0xff;
  return out;
};

/**
 * Reads MVCC data written by MvccWriter (PLAN 10.2): the newest version at or
 * below the read index wins, and a tombstone hides the key.
 */
export class MvccReader {
  readonly #reader: KvReader;

  constructor(reader: KvReader) {
    this.#reader = reader;
  }

  /** The visible value of `logical` at `at` (default latest), with its index. */
  async getVersioned(logical: Uint8Array, at?: bigint): Promise<VersionedValue | undefined> {
    const start = at === undefined ? versionStart(logical) : versionedKey(logical, at);
    for await (const [raw, stored] of this.#reader.iterate(
      { start, end: keyAfter(logical) },
      { limit: 1 },
    )) {
      const parsed = parseVersionedKey(raw);
      const value = decodeVersionValue(stored);
      if (!parsed || value === undefined) return undefined;
      return { key: logical, value, index: parsed.index };
    }
    return undefined;
  }

  /**
   * Index of the newest version of `logical`, tombstones included (0 if it was
   * never written). Any write or delete changes it, which is what WATCH needs.
   */
  async latestIndex(logical: Uint8Array): Promise<bigint> {
    const range = { start: versionStart(logical), end: keyAfter(logical) };
    for await (const [raw] of this.#reader.iterate(range, { limit: 1 })) {
      return parseVersionedKey(raw)?.index ?? 0n;
    }
    return 0n;
  }

  async get(logical: Uint8Array, at?: bigint): Promise<Uint8Array | undefined> {
    return (await this.getVersioned(logical, at))?.value;
  }

  /**
   * Visible keys under `prefix`, one entry per logical key. Keys are yielded in
   * the order of their stored versions, which is key order as long as no key
   * under the prefix extends another (true for every collection's element rows).
   */
  async *scan(prefix: Uint8Array, options: MvccScanOptions = {}): AsyncGenerator<VersionedValue> {
    const start = options.after ? keyAfter(options.after) : (options.from ?? prefix);
    const end = options.before ?? prefixEnd(prefix);
    if (compareBytes(start, end) >= 0) return;
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    let emitted = 0;
    let group: { key: Uint8Array; best?: VersionedValue | null } | undefined;

    const flush = (): VersionedValue | undefined => {
      const best = group?.best;
      group = undefined;
      return best ?? undefined;
    };

    const raws = this.#reader.iterate({ start, end }, { reverse: options.reverse ?? false });
    for await (const [raw, stored] of raws) {
      const parsed = parseVersionedKey(raw);
      if (!parsed) continue;
      if (group && compareBytes(group.key, parsed.logical) !== 0) {
        const done = flush();
        if (done) {
          yield done;
          if (++emitted >= limit) return;
        }
      }
      group ??= { key: parsed.logical.slice() };
      if (options.at !== undefined && parsed.index > options.at) continue;
      // Forward order meets the newest version first; reverse meets it last.
      if (group.best !== undefined && !options.reverse) continue;
      const value = decodeVersionValue(stored);
      group.best = value === undefined ? null : { key: group.key, value, index: parsed.index };
    }
    const last = flush();
    if (last && emitted < limit) yield last;
  }
}
