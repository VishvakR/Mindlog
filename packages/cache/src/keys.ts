import type { TupleElement } from '@mindlog/core';
import { KeyFamily, encodeKey, keyPrefix } from '@mindlog/core';

// Cache keys sit in the user scope next to its memory (ADR-0012, ADR-0031):
// entries `(user, 'c', id)`, the dependency index `(user, 'q', memory, id)`
// and the entry count `(user, 'cn')`.

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

/** The user scope's placement key (the same as the memory engine's). */
export const cacheScopeKey = (tenant: string, user: string): Uint8Array => prefix(tenant, [user]);
export const entryKey = (tenant: string, user: string, id: string): Uint8Array =>
  key(tenant, [user, 'c', id]);
export const entryPrefix = (tenant: string, user: string): Uint8Array =>
  prefix(tenant, [user, 'c']);
export const dependencyKey = (tenant: string, user: string, memory: string, id: string) =>
  key(tenant, [user, 'q', memory, id]);
export const dependencyPrefix = (tenant: string, user: string, memory: string): Uint8Array =>
  prefix(tenant, [user, 'q', memory]);
export const countKey = (tenant: string, user: string): Uint8Array => key(tenant, [user, 'cn']);
