import type { TupleElement } from '@mindlog/core';
import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';

// Memory key layout (ADR-0031): everything of a user scope under `tenant · 'm' · (user, sub, …)`.

function key(tenant: string, tuple: TupleElement[]): Uint8Array {
  const k = encodeKey({ tenant, family: KeyFamily.MEMORY, tuple });
  if (!k.ok) throw new RangeError(k.error.message);
  return k.value;
}

function prefix(tenant: string, tuple: TupleElement[]): Uint8Array {
  const p = keyPrefix(tenant, KeyFamily.MEMORY, tuple);
  if (!p.ok) throw new RangeError(p.error.message);
  return p.value;
}

/** Start of a user's memory: the placement key the router locates (PLAN 8.5). */
export const scopeKey = (tenant: string, user: string): Uint8Array => prefix(tenant, [user]);

export const recordKey = (tenant: string, user: string, id: string): Uint8Array =>
  key(tenant, [user, 'r', id]);
export const recordPrefix = (tenant: string, user: string): Uint8Array =>
  prefix(tenant, [user, 'r']);

export const vectorKey = (tenant: string, user: string, id: string): Uint8Array =>
  key(tenant, [user, 'v', id]);
export const vectorPrefix = (tenant: string, user: string): Uint8Array =>
  prefix(tenant, [user, 'v']);

export const postingKey = (tenant: string, user: string, term: string, id: string): Uint8Array =>
  key(tenant, [user, 't', term, id]);
export const postingPrefix = (tenant: string, user: string, term: string): Uint8Array =>
  prefix(tenant, [user, 't', term]);
export const dfKey = (tenant: string, user: string, term: string): Uint8Array =>
  key(tenant, [user, 'd', term]);
export const statsKey = (tenant: string, user: string): Uint8Array => key(tenant, [user, 'b']);

export const entityKey = (tenant: string, user: string, entityId: string): Uint8Array =>
  key(tenant, [user, 'e', entityId]);
export const entityPrefix = (tenant: string, user: string): Uint8Array =>
  prefix(tenant, [user, 'e']);
export const mentionKey = (
  tenant: string,
  user: string,
  entityId: string,
  memoryId: string,
): Uint8Array => key(tenant, [user, 'x', entityId, memoryId]);
export const mentionPrefix = (tenant: string, user: string, entityId: string): Uint8Array =>
  prefix(tenant, [user, 'x', entityId]);

export type EdgeDirection = 'out' | 'in';
export const edgeKey = (
  tenant: string,
  user: string,
  direction: EdgeDirection,
  node: string,
  relation: string,
  other: string,
): Uint8Array => key(tenant, [user, 'g', direction, node, relation, other]);
export const edgePrefix = (
  tenant: string,
  user: string,
  direction: EdgeDirection,
  node: string,
): Uint8Array => prefix(tenant, [user, 'g', direction, node]);

/** Bumped by every commit and forget of the scope; the vector cache checks it (ADR-0008). */
export const generationKey = (tenant: string, user: string): Uint8Array => key(tenant, [user, 's']);
