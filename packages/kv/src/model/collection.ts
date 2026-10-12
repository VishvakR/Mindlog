import type { KvHeader, KvReply } from '@mindlog/proto';
import type { KvType } from '@mindlog/proto';
import type { Keyspace } from './keyspace.js';
import { errors } from './replies.js';

/**
 * Opens a collection of the expected type: its header, `undefined` if the key
 * is missing (or a fresh header when `create`), or WRONGTYPE.
 */
export async function openCollection(
  ks: Keyspace,
  name: Uint8Array,
  type: KvType,
  create: boolean,
): Promise<KvHeader | undefined | KvReply> {
  const header = await ks.header(name);
  if (!header) return create ? ks.fresh(type) : undefined;
  return header.type === type ? header : errors.wrongType();
}

/** Writes a collection's header, or deletes the key once it has no elements (Redis semantics). */
export function saveCollection(ks: Keyspace, name: Uint8Array, header: KvHeader): void {
  if (header.count === 0n) {
    if (header.version !== 0n) ks.delete(name, header);
  } else {
    ks.write(name, header);
  }
}

export const isHeader = (value: KvHeader | KvReply | undefined): value is KvHeader =>
  value !== undefined && 'generation' in value;
