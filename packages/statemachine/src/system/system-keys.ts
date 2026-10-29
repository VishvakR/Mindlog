import type { Tuple, TupleElement } from '@mindlog/core';
import { NODE_TENANT, encodeKey, keyPrefix } from '@mindlog/core';

function systemKey(tuple: Tuple): Uint8Array {
  const encoded = encodeKey({ tenant: NODE_TENANT, family: 's', tuple });
  if (!encoded.ok) throw new RangeError(encoded.error.message);
  return encoded.value;
}

/**
 * A range-local key: `$node/s/('r', rangeId, tag, ...rest)` (ADR-0028). All of
 * a range's own state shares one prefix, so a snapshot, split or merge can
 * find it without knowing the tags.
 */
export function rangeLocalKey(rangeId: bigint, tag: string, ...rest: TupleElement[]): Uint8Array {
  return systemKey(['r', rangeId, tag, ...rest]);
}

/** Prefix of every range-local key of `rangeId`, or of one tag of it. */
export function rangeLocalPrefix(rangeId: bigint, ...tuple: TupleElement[]): Uint8Array {
  const prefix = keyPrefix(NODE_TENANT, 's', ['r', rangeId, ...tuple]);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** Prefix of every range-local key of every range. */
export function allRangesPrefix(): Uint8Array {
  const prefix = keyPrefix(NODE_TENANT, 's', ['r']);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** Last applied log index of a range, written with each apply (ADR-0005). */
export const appliedIndexKey = (rangeId: bigint): Uint8Array => rangeLocalKey(rangeId, 'applied');

/** Applied membership of a range, written with the apply that changed it (ADR-0006). */
export const confStateKey = (rangeId: bigint): Uint8Array => rangeLocalKey(rangeId, 'conf-state');

/** Applied `RangeDescriptor` (ADR-0009). */
export const rangeDescriptorKey = (rangeId: bigint): Uint8Array =>
  rangeLocalKey(rangeId, 'range-desc');

/** A replica id removed from the range (kept so any member can tell a zombie it is gone, ADR-0028). */
export const removedKey = (rangeId: bigint, replicaId: bigint): Uint8Array =>
  rangeLocalKey(rangeId, 'removed', replicaId);

/** The Raft id this node's replica of the range was created with (ADR-0028). */
export const replicaIdKey = (rangeId: bigint): Uint8Array => rangeLocalKey(rangeId, 'replica-id');

/** Newest MVCC version the range assigned (ADR-0027). */
export const lastVersionKey = (rangeId: bigint): Uint8Array =>
  rangeLocalKey(rangeId, 'last-version');

/** Stored result of a request, keyed by its request id (PLAN 6.2). */
export const idempotencyKey = (rangeId: bigint, requestId: Uint8Array): Uint8Array =>
  rangeLocalKey(rangeId, 'idem', requestId);

/**
 * A request a frozen range refused (ADR-0009). Kept apart from `idem`: a merge folds `idem` in,
 * and replicas reach the merge having seen different numbers of refusals.
 */
export const refusalKey = (rangeId: bigint, requestId: Uint8Array): Uint8Array =>
  rangeLocalKey(rangeId, 'refused', requestId);

/** Version-ordered index of idempotency records, for retention GC. */
export const idempotencyAgeKey = (
  rangeId: bigint,
  version: bigint,
  requestId: Uint8Array,
): Uint8Array => rangeLocalKey(rangeId, 'idem-at', version, requestId);

export const idempotencyAgePrefix = (rangeId: bigint): Uint8Array =>
  rangeLocalPrefix(rangeId, 'idem-at');

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

/** A replica removed from its range; outside the range's own keys so destroying the range keeps it. */
export const tombstoneKey = (rangeId: bigint, replicaId: bigint): Uint8Array =>
  systemKey(['tombstone', rangeId, replicaId]);

export function tombstonePrefix(): Uint8Array {
  const prefix = keyPrefix(NODE_TENANT, 's', ['tombstone']);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** On-disk format version of a store (ADR-0026). */
export function formatKey(): Uint8Array {
  return systemKey(['format']);
}

/** Every key of a store: encoded keys never start with 0xff (a tuple type code). */
export const WHOLE_STORE = { start: new Uint8Array(), end: Uint8Array.of(0xff) } as const;
