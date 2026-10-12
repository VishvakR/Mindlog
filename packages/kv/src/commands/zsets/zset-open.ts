import type { KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { isHeader, openCollection } from '../../model/collection.js';
import type { Keyspace } from '../../model/keyspace.js';
import { ZsetOps } from './zset-ops.js';

export async function openZset(
  ks: Keyspace,
  name: Uint8Array,
  create: boolean,
): Promise<ZsetOps | undefined | KvReply> {
  const header = await openCollection(ks, name, KvType.ZSET, create);
  return isHeader(header) ? new ZsetOps(ks, name, header) : header;
}

export const isZset = (v: ZsetOps | undefined | KvReply): v is ZsetOps => v instanceof ZsetOps;
