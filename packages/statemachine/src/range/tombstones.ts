import { decodeKey, prefixRange } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { tombstoneKey, tombstonePrefix } from '../system/system-keys.js';

/**
 * Replicas that were removed from their range, as `rangeId/replicaId`. A
 * removed replica's id is never used again (ADR-0028), and messages addressed
 * to it must not bring it back to life, or it could vote again in a term it
 * already voted in.
 */
export async function loadTombstones(store: KvStore): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const [key] of store.iterate(prefixRange(tombstonePrefix()))) {
    const decoded = decodeKey(key);
    const [, rangeId, replicaId] = decoded.ok ? decoded.value.tuple : [];
    if (typeof rangeId === 'bigint' && typeof replicaId === 'bigint')
      out.add(`${rangeId}/${replicaId}`);
  }
  return out;
}

export async function writeTombstone(
  store: KvStore,
  rangeId: bigint,
  replicaId: bigint,
): Promise<void> {
  const batch = store.batch();
  batch.put(tombstoneKey(rangeId, replicaId), new Uint8Array());
  await batch.write({ sync: true });
}
