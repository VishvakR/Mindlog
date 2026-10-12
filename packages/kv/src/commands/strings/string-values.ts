import type { KvHeader, KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import type { Keyspace } from '../../model/keyspace.js';
import { errors } from '../../model/replies.js';

/** A key's string value: `undefined` if missing, an error reply for other types. */
export async function readString(
  ks: Keyspace,
  name: Uint8Array,
): Promise<{ header: KvHeader; value: Uint8Array } | undefined | KvReply> {
  const header = await ks.header(name);
  if (!header) return undefined;
  if (header.type !== KvType.STRING) return errors.wrongType();
  return { header, value: header.value };
}

/**
 * Stores a string, replacing whatever the key held (Redis SET semantics). The
 * TTL is cleared unless `keepTtl`; a replaced collection's elements become a
 * dead generation.
 */
export function writeString(
  ks: Keyspace,
  name: Uint8Array,
  value: Uint8Array,
  existing: KvHeader | undefined,
  options: { keepTtl?: boolean; expireAtMs?: bigint } = {},
): void {
  let header: KvHeader;
  if (existing?.type === KvType.STRING) {
    header = existing;
  } else {
    if (existing) ks.delete(name, existing);
    header = ks.fresh(KvType.STRING);
  }
  if (options.expireAtMs !== undefined) ks.setExpiry(name, header, options.expireAtMs);
  else if (!options.keepTtl && header.expireAtMs !== 0n) ks.setExpiry(name, header, 0n);
  header.value = value;
  ks.write(name, header);
}
