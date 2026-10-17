import { create } from '@bufbuild/protobuf';
import type { KeyRange } from '@mindlog/core';
import { NODE_TENANT, keyPrefix, prefixRange } from '@mindlog/core';
import type { RangeDescriptor } from '@mindlog/proto';
import { RangeDescriptorSchema, RangeEpochSchema } from '@mindlog/proto';
import type { Entry, IterateOptions, KvReader } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import { WHOLE_STORE } from '../system/system-keys.js';

const NODE_KEYS: KeyRange = (() => {
  const prefix = keyPrefix(NODE_TENANT);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefixRange(prefix.value);
})();

/**
 * Applied index (and term) of a range's initial state, written by bootstrap
 * or by the split that created it (TiKV's RAFT_INIT_LOG_INDEX). Replicas that
 * start empty are therefore always caught up by a snapshot (ADR-0028).
 */
export const RANGE_INIT_INDEX = 5n;

const NOTHING = Uint8Array.of(0);

/** A replica that has no data yet: its span is empty until a snapshot or split. */
export const uninitialised = (rangeId: bigint): RangeDescriptor =>
  create(RangeDescriptorSchema, { rangeId, startKey: NOTHING, endKey: NOTHING });

export const isUninitialised = (d: RangeDescriptor): boolean =>
  d.endKey.length > 0 && compareBytes(d.startKey, d.endKey) >= 0;

/** The first range of a cluster: every replicated key (ADR-0009). */
export const wholeKeyspace = (rangeId: bigint): RangeDescriptor =>
  create(RangeDescriptorSchema, { rangeId, epoch: create(RangeEpochSchema, {}) });

const endOf = (d: RangeDescriptor): Uint8Array =>
  d.endKey.length === 0 ? WHOLE_STORE.end : d.endKey;

/** True if the replicated key `key` belongs to the range. */
export function inSpan(d: RangeDescriptor, key: Uint8Array): boolean {
  if (compareBytes(key, d.startKey) < 0 || compareBytes(key, endOf(d)) >= 0) return false;
  return compareBytes(key, NODE_KEYS.start) < 0 || compareBytes(key, NODE_KEYS.end) >= 0;
}

const max = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) >= 0 ? a : b);
const min = (a: Uint8Array, b: Uint8Array) => (compareBytes(a, b) <= 0 ? a : b);

/** `[start, end)` of the range minus the node-local keys, intersected with `within`. */
export function spanIntervals(d: RangeDescriptor, within: KeyRange = WHOLE_STORE): KeyRange[] {
  const start = max(d.startKey, within.start);
  const end = min(endOf(d), within.end);
  const parts: KeyRange[] = [
    { start, end: min(end, NODE_KEYS.start) },
    { start: max(start, NODE_KEYS.end), end },
  ];
  return parts.filter((p) => compareBytes(p.start, p.end) < 0);
}

/**
 * A reader that sees only the range's keys, so an apply never reads another
 * range's data that happens to share this node's store: that data differs
 * between nodes, and reading it would break deterministic apply.
 */
export class SpanReader implements KvReader {
  constructor(
    readonly reader: KvReader,
    readonly descriptor: RangeDescriptor,
  ) {}

  get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return inSpan(this.descriptor, key) ? this.reader.get(key) : Promise.resolve(undefined);
  }

  async *iterate(range: KeyRange, options: IterateOptions = {}): AsyncIterable<Entry> {
    const parts = spanIntervals(this.descriptor, range);
    if (options.reverse) parts.reverse();
    let left = options.limit ?? Number.POSITIVE_INFINITY;
    for (const part of parts) {
      if (left <= 0) return;
      for await (const entry of this.reader.iterate(part, { ...options, limit: left })) {
        yield entry;
        left--;
      }
    }
  }
}
