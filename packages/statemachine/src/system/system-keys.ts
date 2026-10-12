import type { Tuple } from '@mindlog/core';
import { SYSTEM_TENANT, encodeKey, keyPrefix } from '@mindlog/core';

function systemKey(tuple: Tuple): Uint8Array {
  const encoded = encodeKey({ tenant: SYSTEM_TENANT, family: 's', tuple });
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

/** One log entry of a range in the log store. */
export function logEntryKey(rangeId: bigint, index: bigint): Uint8Array {
  return systemKey(['raftlog', rangeId, index]);
}

/** Prefix of every log entry of a range. */
export function logPrefix(rangeId: bigint): Uint8Array {
  const prefix = keyPrefix(SYSTEM_TENANT, 's', ['raftlog', rangeId]);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}
