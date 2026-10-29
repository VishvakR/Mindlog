import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';
import { rangeLocalKey, rangeLocalPrefix } from '@mindlog/statemachine';

/** The job record, in its user scope next to the memory it works on (ADR-0017, ADR-0031). */
export function jobKey(tenant: string, user: string, id: string): Uint8Array {
  const key = encodeKey({ tenant, family: KeyFamily.MEMORY, tuple: [user, 'j', id] });
  if (!key.ok) throw new RangeError(key.error.message);
  return key.value;
}

/** Prefix of every job record (dead ones too) of a user scope. */
export function jobPrefix(tenant: string, user: string): Uint8Array {
  const prefix = keyPrefix(tenant, KeyFamily.MEMORY, [user, 'j']);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** Due-time index entry: the run time while queued, the lease end while leased. */
export const jobIndexKey = (
  rangeId: bigint,
  atMs: bigint,
  tenant: string,
  user: string,
  id: string,
): Uint8Array => rangeLocalKey(rangeId, 'jobs', atMs, tenant, user, id);

export const jobIndexPrefix = (rangeId: bigint): Uint8Array => rangeLocalPrefix(rangeId, 'jobs');
