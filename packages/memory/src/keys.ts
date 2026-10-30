import type { TupleElement } from '@mindlog/core';
import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';

// Memory key layout (ADR-0031): everything of a user scope under `tenant · 'm' · (user, sub, …)`.

/**
 * Where memory keys live: a user's main space, or a branch's own space
 * `m/(user, 'w', branch, …)` with the same layout (ADR-0013).
 */
export type Root = string | { readonly user: string; readonly branch: string };

const MAIN = 'main';

/** The root of a user's branch; `main` (or '') is the user's main space. */
export const rootOf = (user: string, branch?: string): Root =>
  branch && branch !== MAIN ? { user, branch } : user;

const head = (root: Root): TupleElement[] =>
  typeof root === 'string' ? [root] : [root.user, 'w', root.branch];

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

export const recordKey = (tenant: string, user: Root, id: string): Uint8Array =>
  key(tenant, [...head(user), 'r', id]);
export const recordPrefix = (tenant: string, user: Root): Uint8Array =>
  prefix(tenant, [...head(user), 'r']);

export const vectorKey = (tenant: string, user: Root, id: string): Uint8Array =>
  key(tenant, [...head(user), 'v', id]);
export const vectorPrefix = (tenant: string, user: Root): Uint8Array =>
  prefix(tenant, [...head(user), 'v']);

export const postingKey = (tenant: string, user: Root, term: string, id: string): Uint8Array =>
  key(tenant, [...head(user), 't', term, id]);
export const postingPrefix = (tenant: string, user: Root, term: string): Uint8Array =>
  prefix(tenant, [...head(user), 't', term]);
export const dfKey = (tenant: string, user: Root, term: string): Uint8Array =>
  key(tenant, [...head(user), 'd', term]);
export const statsKey = (tenant: string, user: Root): Uint8Array =>
  key(tenant, [...head(user), 'b']);

export const entityKey = (tenant: string, user: Root, entityId: string): Uint8Array =>
  key(tenant, [...head(user), 'e', entityId]);
export const entityPrefix = (tenant: string, user: Root): Uint8Array =>
  prefix(tenant, [...head(user), 'e']);
export const mentionKey = (
  tenant: string,
  user: Root,
  entityId: string,
  memoryId: string,
): Uint8Array => key(tenant, [...head(user), 'x', entityId, memoryId]);
export const mentionPrefix = (tenant: string, user: Root, entityId: string): Uint8Array =>
  prefix(tenant, [...head(user), 'x', entityId]);

export type EdgeDirection = 'out' | 'in';
export const edgeKey = (
  tenant: string,
  user: Root,
  direction: EdgeDirection,
  node: string,
  relation: string,
  other: string,
): Uint8Array => key(tenant, [...head(user), 'g', direction, node, relation, other]);
export const edgePrefix = (
  tenant: string,
  user: Root,
  direction: EdgeDirection,
  node: string,
): Uint8Array => prefix(tenant, [...head(user), 'g', direction, node]);

/** Bumped by every commit and forget of the scope; the vector cache checks it (ADR-0008). */
export const generationKey = (tenant: string, user: Root): Uint8Array =>
  key(tenant, [...head(user), 's']);

/** Index-time table: the version of each memory command's log index (PLAN 13.3 `ASOF index`). */
export const indexTimeKey = (tenant: string, user: string, index: bigint): Uint8Array =>
  key(tenant, [user, 'ix', index]);
export const indexTimePrefix = (tenant: string, user: string): Uint8Array =>
  prefix(tenant, [user, 'ix']);

/** Conflict records, and the open ones (ADR-0015). */
export const conflictKey = (tenant: string, user: Root, id: string): Uint8Array =>
  key(tenant, [...head(user), 'k', id]);
export const conflictPrefix = (tenant: string, user: Root): Uint8Array =>
  prefix(tenant, [...head(user), 'k']);
export const openConflictKey = (tenant: string, user: Root, id: string): Uint8Array =>
  key(tenant, [...head(user), 'ko', id]);
export const openConflictPrefix = (tenant: string, user: Root): Uint8Array =>
  prefix(tenant, [...head(user), 'ko']);

/** Provenance indexes (PLAN 13.4): memories by source reference, and by the memory they derive from. */
export const sourceRefKey = (tenant: string, user: Root, ref: string, id: string): Uint8Array =>
  key(tenant, [...head(user), 'sr', ref, id]);
export const sourceRefPrefix = (tenant: string, user: Root, ref: string): Uint8Array =>
  prefix(tenant, [...head(user), 'sr', ref]);
export const derivedKey = (tenant: string, user: Root, from: string, id: string): Uint8Array =>
  key(tenant, [...head(user), 'dv', from, id]);
export const derivedPrefix = (tenant: string, user: Root, from: string): Uint8Array =>
  prefix(tenant, [...head(user), 'dv', from]);
