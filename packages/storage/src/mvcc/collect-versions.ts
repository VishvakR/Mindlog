import type { KvReader, WriteBatch } from '../store/kv-store.js';
import { compareBytes } from '../store/compare-bytes.js';
import { decodeVersionValue } from './version-value.js';
import { keyAfter, parseVersionedKey } from './versioned-key.js';

export interface CollectOptions {
  /** Versions below this index may go; reads at or above it are unaffected. */
  readonly belowIndex: bigint;
  /** Maximum raw entries to delete in this pass. */
  readonly limit: number;
  /** Resume after this logical key (from a previous pass). */
  readonly after?: Uint8Array;
}

export interface CollectResult {
  readonly removed: number;
  /** Where to resume; `undefined` when the prefix is fully collected. */
  readonly resumeAfter?: Uint8Array;
}

/**
 * MVCC garbage collection over one prefix (PLAN 10.2). For each key it keeps
 * every version at or above `belowIndex` plus the newest one below it (so reads
 * at the threshold still see the right value), drops that one too if it is a
 * tombstone, and deletes everything older. Deterministic for a given state, so
 * it can run inside apply; work is bounded by `limit` and resumable.
 */
export async function collectVersions(
  reader: KvReader,
  batch: WriteBatch,
  prefix: Uint8Array,
  options: CollectOptions,
): Promise<CollectResult> {
  const end = new Uint8Array(prefix.length + 1);
  end.set(prefix);
  end[prefix.length] = 0xff;
  const start = options.after ? keyAfter(options.after) : prefix;
  let removed = 0;
  let current: Uint8Array | undefined;
  let keptBelow = false;
  let lastComplete: Uint8Array | undefined;

  for await (const [raw, stored] of reader.iterate({ start, end })) {
    const parsed = parseVersionedKey(raw);
    if (!parsed) continue;
    if (!current || compareBytes(current, parsed.logical) !== 0) {
      if (current) lastComplete = current;
      if (removed >= options.limit && lastComplete) return { removed, resumeAfter: lastComplete };
      current = parsed.logical.slice();
      keptBelow = false;
    }
    if (parsed.index >= options.belowIndex) continue;
    if (!keptBelow) {
      keptBelow = true;
      // The newest version below the threshold stays unless it is a tombstone.
      if (decodeVersionValue(stored) !== undefined) continue;
    }
    batch.del(raw);
    removed++;
  }
  return { removed };
}
