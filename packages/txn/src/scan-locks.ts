import { fromBinary } from '@bufbuild/protobuf';
import { decodeKey, prefixRange } from '@mindlog/core';
import type { TxnLock } from '@mindlog/proto';
import { TxnLockSchema } from '@mindlog/proto';
import { rangeLocalPrefix } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { LOCK } from './lock-store.js';

export interface HeldLock {
  readonly tenant: string;
  readonly key: Uint8Array;
  readonly lock: TxnLock;
}

/** The locks held in a range's state, up to `limit`, for the resolver (ADR-0030). */
export async function scanLocks(
  reader: KvReader,
  rangeId: bigint,
  limit = 100,
): Promise<HeldLock[]> {
  const out: HeldLock[] = [];
  for await (const [raw, value] of reader.iterate(prefixRange(rangeLocalPrefix(rangeId, LOCK)))) {
    const decoded = decodeKey(raw);
    if (!decoded.ok) continue;
    const [, , , tenant, key] = decoded.value.tuple;
    if (typeof tenant !== 'string' || !(key instanceof Uint8Array)) continue;
    out.push({ tenant, key, lock: fromBinary(TxnLockSchema, value) });
    if (out.length >= limit) break;
  }
  return out;
}
