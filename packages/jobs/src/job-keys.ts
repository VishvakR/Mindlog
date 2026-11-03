import type { TupleElement } from '@mindlog/core';
import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';
import { rangeLocalKey, rangeLocalPrefix } from '@mindlog/statemachine';

/**
 * Job scopes are memory users, or a collection (ADR-0034) written as
 * `COLLECTION_SCOPE + name`. Memory scope names never start with it (the
 * memory schemas reject control characters).
 */
export const COLLECTION_SCOPE = '\u0001c:';

/** The job scope of a collection, whose jobs live in its own range. */
export const collectionScope = (collection: string): string => COLLECTION_SCOPE + collection;

function place(scope: string, rest: TupleElement[]): { family: KeyFamily; tuple: TupleElement[] } {
  return scope.startsWith(COLLECTION_SCOPE)
    ? { family: KeyFamily.COLLECTION, tuple: [scope.slice(COLLECTION_SCOPE.length), 'j', ...rest] }
    : { family: KeyFamily.MEMORY, tuple: [scope, 'j', ...rest] };
}

/** The job record, in its scope next to the data it works on (ADR-0017, ADR-0031, ADR-0034). */
export function jobKey(tenant: string, user: string, id: string): Uint8Array {
  const key = encodeKey({ tenant, ...place(user, [id]) });
  if (!key.ok) throw new RangeError(key.error.message);
  return key.value;
}

/** Prefix of every job record (dead ones too) of a scope. */
export function jobPrefix(tenant: string, user: string): Uint8Array {
  const { family, tuple } = place(user, []);
  const prefix = keyPrefix(tenant, family, tuple);
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
