import { decodeKey } from '@mindlog/core';

/** The last tuple element of an element key (the field, member, …), properly unescaped. */
export function lastElement(key: Uint8Array): Uint8Array {
  const decoded = decodeKey(key);
  const last = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
  if (!(last instanceof Uint8Array)) throw new Error('malformed element key');
  return last;
}

/** The tuple elements after `skip` leading ones (e.g. score and member of a by-score row). */
export function tailElements(key: Uint8Array, skip: number) {
  const decoded = decodeKey(key);
  if (!decoded.ok) throw new Error('malformed element key');
  return decoded.value.tuple.slice(skip);
}
