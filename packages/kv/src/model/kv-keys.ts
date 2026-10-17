import type { TupleElement } from '@mindlog/core';
import { encodeKey, keyPrefix } from '@mindlog/core';
import { rangeLocalKey, rangeLocalPrefix } from '@mindlog/statemachine';

/** Element tags inside a collection (ADR-0022). */
export const Tag = {
  HASH: 'h',
  LIST: 'l',
  SET: 's',
  ZSET_BY_MEMBER: 'z',
  ZSET_BY_SCORE: 'Z',
} as const;
export type Tag = (typeof Tag)[keyof typeof Tag];

function key(tenant: string, tuple: TupleElement[]): Uint8Array {
  const encoded = encodeKey({ tenant, family: 'k', tuple });
  if (!encoded.ok) throw new RangeError(encoded.error.message);
  return encoded.value;
}

function prefix(tenant: string, family: 'k' | 's', tuple: TupleElement[]): Uint8Array {
  const encoded = keyPrefix(tenant, family, tuple);
  if (!encoded.ok) throw new RangeError(encoded.error.message);
  return encoded.value;
}

/** k/(key): the header of a Redis key. */
export const headerKey = (tenant: string, name: Uint8Array): Uint8Array => key(tenant, [name]);

/** Prefix of every header (and element) of a tenant, for SCAN/KEYS/DBSIZE. */
export const tenantPrefix = (tenant: string): Uint8Array => prefix(tenant, 'k', []);

/** k/(key, gen, tag): prefix of one generation's elements of one kind. */
export const elementPrefix = (
  tenant: string,
  name: Uint8Array,
  gen: bigint,
  tag: Tag,
): Uint8Array => prefix(tenant, 'k', [name, gen, tag]);

/** k/(key, gen, tag, ...rest): one element. */
export const elementKey = (
  tenant: string,
  name: Uint8Array,
  gen: bigint,
  tag: Tag,
  ...rest: TupleElement[]
): Uint8Array => key(tenant, [name, gen, tag, ...rest]);

/** k/(key, gen): prefix of every element of one generation, all tags. */
export const generationPrefix = (tenant: string, name: Uint8Array, gen: bigint): Uint8Array =>
  prefix(tenant, 'k', [name, gen]);

/** k/(key, gen, ...rest) from an element's tag-and-rest tuple (used to move elements). */
export const encodeElementKey = (
  tenant: string,
  name: Uint8Array,
  gen: bigint,
  rest: TupleElement[],
): Uint8Array => key(tenant, [name, gen, ...rest]);

/** Range-local (expire, atMs, tenant, key): the range's keys due for expiry, in time order (ADR-0028). */
export const expiryIndexKey = (
  rangeId: bigint,
  atMs: bigint,
  tenant: string,
  name: Uint8Array,
): Uint8Array => rangeLocalKey(rangeId, 'expire', atMs, tenant, name);

export const expiryIndexPrefix = (rangeId: bigint): Uint8Array =>
  rangeLocalPrefix(rangeId, 'expire');

/** Range-local (deadgen, deathVersion, tenant, key, gen): generations awaiting GC, oldest first. */
export const deadGenerationKey = (
  rangeId: bigint,
  deathVersion: bigint,
  tenant: string,
  name: Uint8Array,
  gen: bigint,
): Uint8Array => rangeLocalKey(rangeId, 'deadgen', deathVersion, tenant, name, gen);

export const deadGenerationPrefix = (rangeId: bigint): Uint8Array =>
  rangeLocalPrefix(rangeId, 'deadgen');
