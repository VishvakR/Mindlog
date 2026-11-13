import { prefixRange } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { nodePrefix, operatorPrefix, rangeEndPrefix, rangePrefix } from './pd-keys.js';

/**
 * Forgets where the backed-up cluster placed its replicas (ADR-0041): nodes,
 * ranges and operators. The id counter, TSO and cluster version stay, so a
 * restored cluster never reuses an id or a timestamp; the range directory
 * fills in again from the restored node's range heartbeats.
 */
export async function clearPlacement(store: KvStore): Promise<void> {
  const batch = store.batch();
  for (const prefix of [nodePrefix(), rangePrefix(), rangeEndPrefix(), operatorPrefix()])
    for await (const [key] of store.iterate(prefixRange(prefix))) batch.del(key);
  await batch.write({ sync: true });
}
