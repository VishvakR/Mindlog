import { KeyFamily, decodeKey, keyPrefix, prefixRange } from '@mindlog/core';
import type { KvReader } from '@mindlog/storage';
import { keyAfter } from '@mindlog/storage';
import { scopeKey } from '../keys.js';
import { MemoryReads } from './memory-reads.js';

/**
 * The oldest fork version among the open branches in a range (ADR-0013), so
 * GC keeps the history they read; undefined when there are none. Skips from
 * one user scope (or one tenant's non-memory family) to the next, so the cost
 * is one seek per scope, not per key.
 */
export async function oldestOpenFork(
  reader: KvReader,
  span: { readonly start: Uint8Array; readonly end: Uint8Array },
): Promise<bigint | undefined> {
  let oldest: bigint | undefined;
  let start = span.start;
  for (;;) {
    let next: Uint8Array | undefined;
    for await (const [key] of reader.iterate({ start, end: span.end }, { limit: 1 })) {
      const decoded = decodeKey(key);
      if (!decoded.ok) {
        next = keyAfter(key);
        break;
      }
      const { tenant, family, tuple } = decoded.value;
      const user = tuple[0];
      if (family === KeyFamily.MEMORY && typeof user === 'string') {
        for await (const b of new MemoryReads(reader, tenant, user).branches())
          if (b.status === 'open' && (oldest === undefined || b.forkVersion < oldest))
            oldest = b.forkVersion;
        next = prefixRange(scopeKey(tenant, user)).end;
      } else {
        const p = keyPrefix(tenant, family);
        next = p.ok ? prefixRange(p.value).end : keyAfter(key);
      }
    }
    if (!next) return oldest;
    start = next;
  }
}
