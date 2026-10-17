import { decodeTuple, keyPrefix } from '@mindlog/core';
import type { RangeDescriptor } from '@mindlog/proto';
import type { KvReader, WriteBatch } from '@mindlog/storage';
import { collectVersions, keyAfter } from '@mindlog/storage';
import { SpanReader } from '../range/span.js';
import { rangeLocalKey } from '../system/system-keys.js';

function tenantOf(raw: Uint8Array): string | undefined {
  const decoded = decodeTuple(raw);
  const first = decoded.ok ? decoded.value.elements[0] : undefined;
  return typeof first === 'string' ? first : undefined;
}

const startsWith = (key: Uint8Array, prefix: Uint8Array): boolean =>
  key.length >= prefix.length && prefix.every((b, i) => key[i] === b);

/** Cursor modes: resume after a logical key, or start at a tenant's prefix. */
const AFTER = 0;
const START_AT = 1;

function encodeCursor(mode: number, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(key.length + 1);
  out[0] = mode;
  out.set(key, 1);
  return out;
}

function decodeCursor(
  stored: Uint8Array | undefined,
): { mode: number; key: Uint8Array } | undefined {
  if (!stored || stored.length < 2) return undefined;
  return { mode: stored[0] ?? AFTER, key: stored.subarray(1) };
}

function tenantPrefix(tenant: string): Uint8Array {
  const prefix = keyPrefix(tenant);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

export interface StateGcResult {
  readonly removed: number;
  /** True once a full pass over the keyspace has finished. */
  readonly completed: boolean;
}

/**
 * MVCC version GC over the range's data (PLAN 10.2), tenant by tenant. Each
 * call deletes at most `limit` entries and records where it stopped in a
 * range-local cursor key, inside the same apply batch, so successive
 * GcThreshold commands sweep the range deterministically on every replica.
 */
export async function collectStateVersions(
  raw: { readonly reader: KvReader; readonly batch: WriteBatch },
  descriptor: RangeDescriptor,
  belowVersion: bigint,
  limit: number,
): Promise<StateGcResult> {
  const cursorKey = rangeLocalKey(descriptor.rangeId, 'gc-cursor');
  const reader = new SpanReader(raw.reader, descriptor);
  const cursor = decodeCursor(await raw.reader.get(cursorKey));
  let after = cursor?.mode === AFTER ? cursor.key : undefined;
  let start = cursor
    ? cursor.mode === AFTER
      ? keyAfter(cursor.key)
      : cursor.key
    : descriptor.startKey;
  let removed = 0;
  for (;;) {
    let first: Uint8Array | undefined;
    for await (const [key] of reader.iterate({ start, end: Uint8Array.of(0xff) }, { limit: 1 })) {
      first = key;
    }
    const tenant = first ? tenantOf(first) : undefined;
    if (!first || tenant === undefined) {
      raw.batch.del(cursorKey);
      return { removed, completed: true };
    }
    const prefix = tenantPrefix(tenant);
    if (removed >= limit) {
      // Stop between tenants; the next pass starts at this tenant.
      raw.batch.put(cursorKey, encodeCursor(START_AT, prefix));
      return { removed, completed: false };
    }
    const within = after && startsWith(after, prefix) ? after : undefined;
    const remaining = limit - removed;
    const options = within
      ? { belowIndex: belowVersion, limit: remaining, after: within }
      : { belowIndex: belowVersion, limit: remaining };
    const result = await collectVersions(reader, raw.batch, prefix, options);
    removed += result.removed;
    if (result.resumeAfter) {
      raw.batch.put(cursorKey, encodeCursor(AFTER, result.resumeAfter));
      return { removed, completed: false };
    }
    after = undefined;
    start = keyAfter(prefix);
  }
}
