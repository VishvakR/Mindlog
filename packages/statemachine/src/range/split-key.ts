import { decodeKey, keyPrefix } from '@mindlog/core';
import type { RangeDescriptor } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import { SpanReader } from './span.js';

export interface SplitPoint {
  readonly splitKey: Uint8Array;
  readonly leftBytes: bigint;
  readonly rightBytes: bigint;
}

/**
 * The split boundary of a stored key (ADR-0009): its tenant, family and
 * first tuple element. For KV that is the Redis key, so a key's header,
 * elements and versions stay together; for memory families it is the user
 * scope, so a scope's memory stays in one range.
 */
export function splitBoundary(key: Uint8Array): Uint8Array | undefined {
  const decoded = decodeKey(key);
  if (!decoded.ok) return undefined;
  const { tenant, family, tuple } = decoded.value;
  const prefix = keyPrefix(tenant, family, tuple.slice(0, 1));
  return prefix.ok ? prefix.value : undefined;
}

/**
 * Where to split a range so both halves hold about the same bytes: after the
 * key whose bytes reach half the total, at the next boundary. Runs on the
 * leader before proposing (it scans the range twice), never in apply.
 * `undefined` when the range holds a single boundary.
 */
export async function findSplitKey(
  store: KvReader,
  descriptor: RangeDescriptor,
): Promise<SplitPoint | undefined> {
  const reader = new SpanReader(store, descriptor);
  const all = { start: new Uint8Array(), end: Uint8Array.of(0xff) };
  let total = 0n;
  for await (const [key, value] of reader.iterate(all)) total += BigInt(key.length + value.length);
  let left = 0n;
  let reached: Uint8Array | undefined;
  for await (const [key, value] of reader.iterate(all)) {
    const boundary = splitBoundary(key);
    if (reached && boundary && compareBytes(boundary, reached) > 0)
      return { splitKey: boundary, leftBytes: left, rightBytes: total - left };
    left += BigInt(key.length + value.length);
    if (!reached && left * 2n >= total && boundary) reached = boundary;
  }
  return undefined;
}
