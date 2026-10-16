import type { Tuple } from '@mindlog/core';
import { NODE_TENANT, encodeKey, keyPrefix } from '@mindlog/core';

function systemKey(tuple: Tuple): Uint8Array {
  const encoded = encodeKey({ tenant: NODE_TENANT, family: 's', tuple });
  if (!encoded.ok) throw new RangeError(encoded.error.message);
  return encoded.value;
}

/** Last applied log index of a range, written with each apply (ADR-0005). */
export function appliedIndexKey(rangeId: bigint): Uint8Array {
  return systemKey(['applied', rangeId]);
}

/** Stored result of a request, keyed by its request id (PLAN 6.2). */
export function idempotencyKey(requestId: Uint8Array): Uint8Array {
  return systemKey(['idem', requestId]);
}

/** Time-ordered index of idempotency records, for retention GC. */
export function idempotencyAgeKey(index: bigint, requestId: Uint8Array): Uint8Array {
  return systemKey(['idem-at', index, requestId]);
}

export function idempotencyAgePrefix(): Uint8Array {
  const prefix = keyPrefix(NODE_TENANT, 's', ['idem-at']);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** One log entry of a range in the log store. */
export function logEntryKey(rangeId: bigint, index: bigint): Uint8Array {
  return systemKey(['raftlog', rangeId, index]);
}

/** Prefix of every log entry of a range. */
export function logPrefix(rangeId: bigint): Uint8Array {
  const prefix = keyPrefix(NODE_TENANT, 's', ['raftlog', rangeId]);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/**
 * Last entry removed by compaction or replaced by a snapshot, with its term
 * (ADR-0026), so an empty log still knows where it ends.
 */
export function raftTruncatedKey(rangeId: bigint): Uint8Array {
  return systemKey(['raft-truncated', rangeId]);
}

/** Raft term, vote and commit of a range (ADR-0026). */
export function raftStateKey(rangeId: bigint): Uint8Array {
  return systemKey(['raft-state', rangeId]);
}

/** Applied membership of a range, written with the apply that changed it (ADR-0006). */
export function confStateKey(rangeId: bigint): Uint8Array {
  return systemKey(['conf-state', rangeId]);
}

/** On-disk format version of a store (ADR-0026). */
export function formatKey(): Uint8Array {
  return systemKey(['format']);
}

/** Every key of a store: encoded keys never start with 0xff (a tuple type code). */
export const WHOLE_STORE = { start: new Uint8Array(), end: Uint8Array.of(0xff) } as const;
