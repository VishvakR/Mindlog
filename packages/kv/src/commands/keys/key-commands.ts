import { clone } from '@bufbuild/protobuf';
import { decodeKey } from '@mindlog/core';
import type { KvHeader } from '@mindlog/proto';
import { KvHeaderSchema, KvType } from '@mindlog/proto';
import { compareBytes } from '@mindlog/storage';
import { liveKeys } from '../../model/key-iterator.js';
import { encodeElementKey, generationPrefix } from '../../model/kv-keys.js';
import type { Keyspace } from '../../model/keyspace.js';
import { errors, integer, ok, simple } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';

const ALL_KEYS = { first: 1, last: -1, step: 1 } as const;

export const TYPE_NAMES: Record<KvType, string> = {
  [KvType.UNSPECIFIED]: 'none',
  [KvType.STRING]: 'string',
  [KvType.HASH]: 'hash',
  [KvType.LIST]: 'list',
  [KvType.SET]: 'set',
  [KvType.ZSET]: 'zset',
  [KvType.JSON]: 'ReJSON-RL',
};

const deleteCommand = (name: 'DEL' | 'UNLINK'): KvCommand => ({
  name,
  arity: -2,
  flags: ['write'],
  keys: ALL_KEYS,
  async execute(ks, names) {
    let deleted = 0;
    for (const key of names) {
      const header = await ks.header(key);
      if (header) {
        ks.delete(key, header);
        deleted++;
      }
    }
    return integer(deleted);
  },
});

const EXISTS: KvCommand = {
  name: 'EXISTS',
  arity: -2,
  flags: ['readonly', 'fast'],
  keys: ALL_KEYS,
  async execute(ks, names) {
    let found = 0;
    for (const key of names) if (await ks.header(key)) found++;
    return integer(found);
  },
};

const TYPE: KvCommand = {
  name: 'TYPE',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: { first: 1, last: 1, step: 1 },
  async execute(ks, [key]) {
    const header = await ks.header(key as Uint8Array);
    return simple(header ? TYPE_NAMES[header.type] : 'none');
  },
};

/** Copies a key's current generation to `to` under a new generation (this command's index). */
async function copyElements(ks: Keyspace, from: Uint8Array, header: KvHeader, to: Uint8Array) {
  for await (const entry of ks.context.view.scan(
    generationPrefix(ks.tenant, from, header.generation),
  )) {
    const decoded = decodeKey(entry.key);
    if (!decoded.ok) continue;
    const [, , ...rest] = decoded.value.tuple;
    ks.writer.put(encodeElementKey(ks.tenant, to, ks.context.version, rest), entry.value);
  }
}

const rename = (name: 'RENAME' | 'RENAMENX'): KvCommand => ({
  name,
  arity: 3,
  flags: ['write'],
  keys: { first: 1, last: 2, step: 1 },
  async execute(ks, [rawFrom, rawTo]) {
    const from = rawFrom as Uint8Array;
    const to = rawTo as Uint8Array;
    const source = await ks.header(from);
    if (!source) return errors.noSuchKey();
    const target = await ks.header(to);
    if (name === 'RENAMENX' && target) return integer(0);
    if (compareBytes(from, to) === 0) return name === 'RENAME' ? ok() : integer(0);
    if (target) ks.delete(to, target);
    const moved = clone(KvHeaderSchema, source);
    moved.generation = ks.context.version;
    if (moved.type !== KvType.STRING && moved.type !== KvType.JSON) {
      await copyElements(ks, from, source, to);
    }
    const expireAtMs = source.expireAtMs;
    ks.delete(from, source);
    moved.expireAtMs = 0n;
    if (expireAtMs !== 0n) ks.setExpiry(to, moved, expireAtMs);
    ks.write(to, moved);
    return name === 'RENAME' ? ok() : integer(1);
  },
});

const DBSIZE: KvCommand = {
  name: 'DBSIZE',
  arity: 1,
  flags: ['readonly', 'fast'],
  async execute(ks) {
    let count = 0;
    for await (const _ of liveKeys(ks)) count++;
    return integer(count);
  },
};

export const keyCommands: KvCommand[] = [
  deleteCommand('DEL'),
  deleteCommand('UNLINK'),
  EXISTS,
  TYPE,
  rename('RENAME'),
  rename('RENAMENX'),
  DBSIZE,
];
