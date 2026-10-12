import type { KvHeader, KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { isHeader, openCollection, saveCollection } from '../../model/collection.js';
import { optionName } from '../../model/expire-options.js';
import { globMatch } from '../../model/glob.js';
import type { Keyspace } from '../../model/keyspace.js';
import {
  INT64_MAX,
  INT64_MIN,
  formatDouble,
  parseFloat64,
  parseInteger,
  textBytes,
} from '../../model/numbers.js';
import { decodeCursor, encodeCursor } from '../../model/scan-cursor.js';
import { array, bulk, error, errors, integer, map, nil, ok } from '../../model/replies.js';
import { parseScanOptions } from '../keys/scan.js';
import type { KvCommand } from '../kv-command.js';
import { HashOps } from './hash-ops.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
type Opened = { header: KvHeader; ops: HashOps };

async function open(
  ks: Keyspace,
  name: Uint8Array,
  create: boolean,
): Promise<Opened | undefined | KvReply> {
  const header = await openCollection(ks, name, KvType.HASH, create);
  if (!isHeader(header)) return header;
  return { header, ops: new HashOps(ks, name, header) };
}

const isOpened = (v: Opened | undefined | KvReply): v is Opened => v !== undefined && 'ops' in v;

const hset = (name: 'HSET' | 'HMSET'): KvCommand => ({
  name,
  arity: -4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...pairs]) {
    if (pairs.length % 2 !== 0) return errors.arity(name);
    const hash = await open(ks, key as Uint8Array, true);
    if (!isOpened(hash)) return hash ?? nil();
    let added = 0;
    for (let i = 0; i < pairs.length; i += 2) {
      if (await hash.ops.set(pairs[i] as Uint8Array, pairs[i + 1] as Uint8Array)) added++;
    }
    saveCollection(ks, key as Uint8Array, hash.header);
    return name === 'HSET' ? integer(added) : ok();
  },
});

const HSETNX: KvCommand = {
  name: 'HSETNX',
  arity: 4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field, value]) {
    const hash = await open(ks, key as Uint8Array, true);
    if (!isOpened(hash)) return hash ?? nil();
    if ((await hash.ops.get(field as Uint8Array)) !== undefined) return integer(0);
    await hash.ops.set(field as Uint8Array, value as Uint8Array);
    saveCollection(ks, key as Uint8Array, hash.header);
    return integer(1);
  },
};

const HGET: KvCommand = {
  name: 'HGET',
  arity: 3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (!isOpened(hash)) return hash ?? nil();
    const value = await hash.ops.get(field as Uint8Array);
    return value ? bulk(value) : nil();
  },
};

const HMGET: KvCommand = {
  name: 'HMGET',
  arity: -3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...fields]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (hash !== undefined && !isOpened(hash)) return hash;
    const values = hash
      ? await Promise.all(fields.map((f) => hash.ops.get(f)))
      : fields.map(() => undefined);
    return array(values.map((v) => (v ? bulk(v) : nil())));
  },
};

const HDEL: KvCommand = {
  name: 'HDEL',
  arity: -3,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...fields]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (!isOpened(hash)) return hash ?? integer(0);
    let removed = 0;
    for (const field of fields) if (await hash.ops.delete(field)) removed++;
    if (removed > 0) saveCollection(ks, key as Uint8Array, hash.header);
    return integer(removed);
  },
};

const listing = (name: 'HGETALL' | 'HKEYS' | 'HVALS'): KvCommand => ({
  name,
  arity: 2,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (hash !== undefined && !isOpened(hash)) return hash;
    const pairs: (readonly [KvReply, KvReply])[] = [];
    if (hash) for await (const [f, v] of hash.ops.entries()) pairs.push([bulk(f), bulk(v)]);
    if (name === 'HGETALL') return map(pairs);
    return array(pairs.map(([f, v]) => (name === 'HKEYS' ? f : v)));
  },
});

const HLEN: KvCommand = {
  name: 'HLEN',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (hash !== undefined && !isOpened(hash)) return hash;
    return integer(hash?.header.count ?? 0n);
  },
};

const HEXISTS: KvCommand = {
  name: 'HEXISTS',
  arity: 3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (!isOpened(hash)) return hash ?? integer(0);
    return integer((await hash.ops.get(field as Uint8Array)) === undefined ? 0 : 1);
  },
};

const HSTRLEN: KvCommand = {
  name: 'HSTRLEN',
  arity: 3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field]) {
    const hash = await open(ks, key as Uint8Array, false);
    if (!isOpened(hash)) return hash ?? integer(0);
    return integer((await hash.ops.get(field as Uint8Array))?.length ?? 0);
  },
};

const HINCRBY: KvCommand = {
  name: 'HINCRBY',
  arity: 4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field, amount]) {
    const delta = parseInteger(amount as Uint8Array);
    if (delta === undefined) return errors.notInteger();
    const hash = await open(ks, key as Uint8Array, true);
    if (!isOpened(hash)) return hash ?? nil();
    const raw = await hash.ops.get(field as Uint8Array);
    const current = raw ? parseInteger(raw) : 0n;
    if (current === undefined) return error('INVALID_ARGUMENT', 'hash value is not an integer');
    const next = current + delta;
    if (next > INT64_MAX || next < INT64_MIN) return errors.overflow();
    await hash.ops.set(field as Uint8Array, textBytes(next.toString()));
    saveCollection(ks, key as Uint8Array, hash.header);
    return integer(next);
  },
};

const HINCRBYFLOAT: KvCommand = {
  name: 'HINCRBYFLOAT',
  arity: 4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, field, amount]) {
    const delta = parseFloat64(amount as Uint8Array);
    if (delta === undefined) return errors.notFloat();
    const hash = await open(ks, key as Uint8Array, true);
    if (!isOpened(hash)) return hash ?? nil();
    const raw = await hash.ops.get(field as Uint8Array);
    const current = raw ? parseFloat64(raw) : 0;
    if (current === undefined) return error('INVALID_ARGUMENT', 'hash value is not a float');
    const next = current + delta;
    if (!Number.isFinite(next))
      return error('INVALID_ARGUMENT', 'increment would produce NaN or Infinity');
    const text = textBytes(formatDouble(next));
    await hash.ops.set(field as Uint8Array, text);
    saveCollection(ks, key as Uint8Array, hash.header);
    return bulk(text);
  },
};

/** HSCAN key cursor [MATCH p] [COUNT n] [NOVALUES] */
const HSCAN: KvCommand = {
  name: 'HSCAN',
  arity: -3,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCursor, ...rest]) {
    const after = decodeCursor(rawCursor as Uint8Array);
    if (after === undefined) return error('INVALID_ARGUMENT', 'invalid cursor');
    const noValues = rest.length > 0 && optionName(rest.at(-1)) === 'NOVALUES';
    const options = parseScanOptions(noValues ? rest.slice(0, -1) : rest, false);
    if ('kind' in options) return options;
    const hash = await open(ks, key as Uint8Array, false);
    if (hash !== undefined && !isOpened(hash)) return hash;
    const items: KvReply[] = [];
    let last: Uint8Array | undefined;
    let examined = 0;
    if (hash) {
      for await (const [field, value] of hash.ops.entries(after ?? undefined)) {
        last = field;
        if (!options.match || globMatch(options.match, field)) {
          items.push(bulk(field));
          if (!noValues) items.push(bulk(value));
        }
        if (++examined >= options.count) break;
      }
    }
    const cursor = examined >= options.count && last ? encodeCursor(last) : '0';
    return array([bulk(textBytes(cursor)), array(items)]);
  },
};

export const hashCommands: KvCommand[] = [
  hset('HSET'),
  hset('HMSET'),
  HSETNX,
  HGET,
  HMGET,
  HDEL,
  listing('HGETALL'),
  listing('HKEYS'),
  listing('HVALS'),
  HLEN,
  HEXISTS,
  HSTRLEN,
  HINCRBY,
  HINCRBYFLOAT,
  HSCAN,
];
