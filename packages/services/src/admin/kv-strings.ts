import type { KvReply } from '@mindlog/proto';

const decoder = new TextDecoder();

/** Bulk strings of a reply, flattened (HGETALL map, SCAN arrays). */
export function strings(reply: KvReply): string[] {
  const k = reply.kind;
  if (k.case === 'bulk') return [decoder.decode(k.value)];
  if (k.case === 'simple') return [k.value];
  if (k.case === 'array' || k.case === 'set') return k.value.items.flatMap(strings);
  if (k.case === 'map')
    return k.value.entries.flatMap((e) => [e.key, e.value].flatMap((r) => (r ? strings(r) : [])));
  return [];
}

/** A flat `[field, value, …]` list as an object. */
export const toRecord = (flat: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i] as string] = flat[i + 1] as string;
  return out;
};
