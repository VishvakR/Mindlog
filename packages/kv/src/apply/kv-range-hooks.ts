import { decodeKey, prefixRange } from '@mindlog/core';
import type { RangeHooks, RawState } from '@mindlog/statemachine';
import { rangeLocalPrefix } from '@mindlog/statemachine';
import { compareBytes } from '@mindlog/storage';
import { deadGenerationKey, expiryIndexKey, headerKey } from '../model/kv-keys.js';

/**
 * Moves a range's expiry index and dead-generation records (both range-local,
 * ADR-0028) to `to`, for the entries whose Redis key `keep` selects.
 */
async function move(
  raw: RawState,
  from: bigint,
  to: bigint,
  keep: (header: Uint8Array) => boolean,
): Promise<void> {
  for (const tag of ['expire', 'deadgen'] as const) {
    for await (const [key] of raw.reader.iterate(prefixRange(rangeLocalPrefix(from, tag)))) {
      const decoded = decodeKey(key);
      if (!decoded.ok) continue;
      const [, , , at, tenant, name, gen] = decoded.value.tuple;
      if (typeof at !== 'bigint' || typeof tenant !== 'string' || !(name instanceof Uint8Array))
        continue;
      if (!keep(headerKey(tenant, name))) continue;
      raw.batch.del(key);
      if (tag === 'expire') raw.batch.put(expiryIndexKey(to, at, tenant, name), new Uint8Array());
      else if (typeof gen === 'bigint')
        raw.batch.put(deadGenerationKey(to, at, tenant, name, gen), new Uint8Array());
    }
  }
}

/** KV's part of a split or merge (ADR-0009): its range-local indexes follow their keys. */
export const kvRangeHooks: RangeHooks = {
  split: (raw, left, right, splitKey) =>
    move(raw, left, right, (header) => compareBytes(header, splitKey) >= 0),
  merge: (raw, left, right) => move(raw, right, left, () => true),
};
