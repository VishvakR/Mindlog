import { decodeKey, prefixRange } from '@mindlog/core';
import type { RangeHooks, RawState } from '@mindlog/statemachine';
import { rangeLocalKey, rangeLocalPrefix } from '@mindlog/statemachine';
import { compareBytes } from '@mindlog/storage';
import { headerKey } from '@mindlog/kv';
import { COMMIT, LOCK, ROLLBACK } from './lock-store.js';

/** Moves the lock and record entries of keys `keep` selects from one range's state to another's. */
async function move(
  raw: RawState,
  from: bigint,
  to: bigint,
  keep: (header: Uint8Array) => boolean,
): Promise<void> {
  for (const tag of [LOCK, COMMIT, ROLLBACK]) {
    for await (const [key, value] of raw.reader.iterate(prefixRange(rangeLocalPrefix(from, tag)))) {
      const decoded = decodeKey(key);
      if (!decoded.ok) continue;
      const [, , , tenant, name, ...rest] = decoded.value.tuple;
      if (typeof tenant !== 'string' || !(name instanceof Uint8Array)) continue;
      if (!keep(headerKey(tenant, name))) continue;
      raw.batch.del(key);
      raw.batch.put(rangeLocalKey(to, tag, tenant, name, ...rest), value);
    }
  }
}

/** The transaction state's part of a split or merge: locks and records follow their keys (ADR-0030). */
export const txnRangeHooks: RangeHooks = {
  split: (raw, left, right, splitKey) =>
    move(raw, left, right, (header) => compareBytes(header, splitKey) >= 0),
  merge: (raw, left, right) => move(raw, right, left, () => true),
};
