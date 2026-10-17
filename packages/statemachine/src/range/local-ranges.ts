import { decodeKey, prefixRange } from '@mindlog/core';
import type { KvReader } from '@mindlog/storage';
import { allRangesPrefix, appliedIndexKey, rangeLocalPrefix } from '../system/system-keys.js';

/**
 * Ranges with state in this store (an applied point), in id order: what a
 * node reopens when it starts, including ranges created by splits. Seeks
 * from one range's keys to the next, so it reads one key per range.
 */
export async function localRanges(store: KvReader): Promise<bigint[]> {
  const ids: bigint[] = [];
  const end = prefixRange(allRangesPrefix()).end;
  let start = allRangesPrefix();
  for (;;) {
    let next: bigint | undefined;
    for await (const [key] of store.iterate({ start, end }, { limit: 1 })) {
      const decoded = decodeKey(key);
      const id = decoded.ok ? decoded.value.tuple[1] : undefined;
      if (typeof id === 'bigint') next = id;
    }
    if (next === undefined) return ids;
    if (await store.get(appliedIndexKey(next))) ids.push(next);
    start = prefixRange(rangeLocalPrefix(next)).end;
  }
}
