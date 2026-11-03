import type { TupleElement } from '@mindlog/core';
import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';

// Collection key layout (ADR-0034): everything of a collection under `tenant · 'c' · (collection, sub, …)`.

function key(tenant: string, tuple: TupleElement[]): Uint8Array {
  const k = encodeKey({ tenant, family: KeyFamily.COLLECTION, tuple });
  if (!k.ok) throw new RangeError(k.error.message);
  return k.value;
}

function prefix(tenant: string, tuple: TupleElement[]): Uint8Array {
  const p = keyPrefix(tenant, KeyFamily.COLLECTION, tuple);
  if (!p.ok) throw new RangeError(p.error.message);
  return p.value;
}

/** Start of a collection: the placement key the router locates. */
export const collectionKey = (tenant: string, collection: string): Uint8Array =>
  prefix(tenant, [collection]);
/** Every collection of a tenant. */
export const collectionsPrefix = (tenant: string): Uint8Array => prefix(tenant, []);

export const schemaKey = (tenant: string, collection: string): Uint8Array =>
  key(tenant, [collection, 's']);

export const recordKey = (tenant: string, collection: string, id: string): Uint8Array =>
  key(tenant, [collection, 'r', id]);
export const recordPrefix = (tenant: string, collection: string): Uint8Array =>
  prefix(tenant, [collection, 'r']);

export const indexRowKey = (
  tenant: string,
  collection: string,
  index: string,
  values: readonly TupleElement[],
  id: string,
): Uint8Array => key(tenant, [collection, 'x', index, ...values, id]);
export const indexPrefix = (
  tenant: string,
  collection: string,
  index: string,
  values: readonly TupleElement[] = [],
): Uint8Array => prefix(tenant, [collection, 'x', index, ...values]);

export const uniqueKey = (
  tenant: string,
  collection: string,
  index: string,
  values: readonly TupleElement[],
): Uint8Array => key(tenant, [collection, 'u', index, ...values]);
export const uniquePrefix = (tenant: string, collection: string): Uint8Array =>
  prefix(tenant, [collection, 'u']);
