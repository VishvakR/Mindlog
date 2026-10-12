import type { KvHeader } from '@mindlog/proto';
import { decodeKey } from '@mindlog/core';
import { headerKey, tenantPrefix } from './kv-keys.js';
import type { Keyspace } from './keyspace.js';

export interface LiveKey {
  readonly name: Uint8Array;
  readonly header: KvHeader;
}

/**
 * Live keys of the tenant in key order, starting after `after`. Each step finds
 * the next stored row, takes its key name, checks the header (lazy expiry
 * applies) and jumps past every row of that key, so element rows and dead
 * generations cost one seek per key rather than one per element.
 */
export async function* liveKeys(ks: Keyspace, after?: Uint8Array): AsyncGenerator<LiveKey> {
  const prefix = tenantPrefix(ks.tenant);
  let cursor = after === undefined ? undefined : headerKey(ks.tenant, after);
  for (;;) {
    let next: Uint8Array | undefined;
    const options = cursor === undefined ? { limit: 1 } : { limit: 1, after: cursor };
    for await (const entry of ks.context.view.scan(prefix, options)) {
      const decoded = decodeKey(entry.key);
      const name = decoded.ok ? decoded.value.tuple[0] : undefined;
      if (name instanceof Uint8Array) next = name;
    }
    if (next === undefined) return;
    cursor = headerKey(ks.tenant, next);
    const header = await ks.header(next);
    if (header) yield { name: next, header };
  }
}
