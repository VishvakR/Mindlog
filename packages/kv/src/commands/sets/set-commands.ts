import type { KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { isHeader, openCollection, saveCollection } from '../../model/collection.js';
import { globMatch } from '../../model/glob.js';
import type { Keyspace } from '../../model/keyspace.js';
import { parseInteger, textBytes } from '../../model/numbers.js';
import { decodeCursor, encodeCursor } from '../../model/scan-cursor.js';
import { array, bulk, error, errors, integer, nil, set } from '../../model/replies.js';
import { parseScanOptions } from '../keys/scan.js';
import type { KvCommand } from '../kv-command.js';
import { SetOps } from './set-ops.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

async function open(
  ks: Keyspace,
  name: Uint8Array,
  create: boolean,
): Promise<SetOps | undefined | KvReply> {
  const header = await openCollection(ks, name, KvType.SET, create);
  return isHeader(header) ? new SetOps(ks, name, header) : header;
}

const isSet = (v: SetOps | undefined | KvReply): v is SetOps => v instanceof SetOps;

/** Picks `count` distinct indexes from `[0, size)` with the context's random source. */
function sample(ks: Keyspace, size: number, count: number): number[] {
  const indexes = Array.from({ length: size }, (_, i) => i);
  for (let i = 0; i < Math.min(count, size); i++) {
    const j = i + (ks.random.nextUint32() % (size - i));
    [indexes[i], indexes[j]] = [indexes[j] as number, indexes[i] as number];
  }
  return indexes.slice(0, Math.min(count, size));
}

const SADD: KvCommand = {
  name: 'SADD',
  arity: -3,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...members]) {
    const s = await open(ks, key as Uint8Array, true);
    if (!isSet(s)) return s ?? integer(0);
    let added = 0;
    for (const member of members) if (await s.add(member)) added++;
    if (added > 0) saveCollection(ks, key as Uint8Array, s.header);
    return integer(added);
  },
};

const SREM: KvCommand = {
  name: 'SREM',
  arity: -3,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...members]) {
    const s = await open(ks, key as Uint8Array, false);
    if (!isSet(s)) return s ?? integer(0);
    let removed = 0;
    for (const member of members) if (await s.remove(member)) removed++;
    if (removed > 0) saveCollection(ks, key as Uint8Array, s.header);
    return integer(removed);
  },
};

const SMEMBERS: KvCommand = {
  name: 'SMEMBERS',
  arity: 2,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const s = await open(ks, key as Uint8Array, false);
    if (s !== undefined && !isSet(s)) return s;
    return set(s ? (await s.all()).map(bulk) : []);
  },
};

const SISMEMBER: KvCommand = {
  name: 'SISMEMBER',
  arity: 3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, member]) {
    const s = await open(ks, key as Uint8Array, false);
    if (!isSet(s)) return s ?? integer(0);
    return integer((await s.has(member as Uint8Array)) ? 1 : 0);
  },
};

const SMISMEMBER: KvCommand = {
  name: 'SMISMEMBER',
  arity: -3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...members]) {
    const s = await open(ks, key as Uint8Array, false);
    if (s !== undefined && !isSet(s)) return s;
    const flags = await Promise.all(members.map(async (m) => (s ? s.has(m) : false)));
    return array(flags.map((f) => integer(f ? 1 : 0)));
  },
};

const SCARD: KvCommand = {
  name: 'SCARD',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const s = await open(ks, key as Uint8Array, false);
    if (!isSet(s)) return s ?? integer(0);
    return integer(s.header.count);
  },
};

const SPOP: KvCommand = {
  name: 'SPOP',
  arity: -2,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCount]) {
    let count: bigint | undefined;
    if (rawCount) {
      count = parseInteger(rawCount);
      if (count === undefined || count < 0n) {
        return error('INVALID_ARGUMENT', 'value is out of range, must be positive');
      }
    }
    const s = await open(ks, key as Uint8Array, false);
    if (!isSet(s)) return s ?? (count === undefined ? nil() : array([]));
    const members = await s.all();
    const chosen = sample(ks, members.length, Number(count ?? 1n)).map(
      (i) => members[i] as Uint8Array,
    );
    for (const member of chosen) await s.remove(member);
    saveCollection(ks, key as Uint8Array, s.header);
    if (count === undefined) return chosen[0] ? bulk(chosen[0]) : nil();
    return set(chosen.map(bulk));
  },
};

const SRANDMEMBER: KvCommand = {
  name: 'SRANDMEMBER',
  arity: -2,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCount]) {
    const count = rawCount ? parseInteger(rawCount) : undefined;
    if (rawCount && count === undefined) return errors.notInteger();
    const s = await open(ks, key as Uint8Array, false);
    if (s !== undefined && !isSet(s)) return s;
    const members = s ? await s.all() : [];
    if (count === undefined) {
      const [pick] = sample(ks, members.length, 1);
      return pick === undefined ? nil() : bulk(members[pick] as Uint8Array);
    }
    if (count >= 0n)
      return array(
        sample(ks, members.length, Number(count)).map((i) => bulk(members[i] as Uint8Array)),
      );
    if (members.length === 0) return array([]);
    const picks = Array.from(
      { length: Number(-count) },
      () => ks.random.nextUint32() % members.length,
    );
    return array(picks.map((i) => bulk(members[i] as Uint8Array)));
  },
};

const algebra = (name: 'SINTER' | 'SUNION' | 'SDIFF'): KvCommand => ({
  name,
  arity: -2,
  flags: ['readonly'],
  keys: { first: 1, last: -1, step: 1 },
  async execute(ks, keys) {
    const sets: Map<string, Uint8Array>[] = [];
    for (const key of keys) {
      const s = await open(ks, key, false);
      if (s !== undefined && !isSet(s)) return s;
      sets.push(new Map((s ? await s.all() : []).map((m) => [hex(m), m])));
    }
    const [first = new Map<string, Uint8Array>(), ...rest] = sets;
    const result = new Map(first);
    if (name === 'SUNION') for (const other of rest) for (const [k, m] of other) result.set(k, m);
    if (name === 'SINTER')
      for (const k of [...result.keys()]) if (!rest.every((o) => o.has(k))) result.delete(k);
    if (name === 'SDIFF') for (const other of rest) for (const k of other.keys()) result.delete(k);
    return set([...result.values()].map(bulk));
  },
});

const SSCAN: KvCommand = {
  name: 'SSCAN',
  arity: -3,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCursor, ...rest]) {
    const after = decodeCursor(rawCursor as Uint8Array);
    if (after === undefined) return error('INVALID_ARGUMENT', 'invalid cursor');
    const options = parseScanOptions(rest, false);
    if ('kind' in options) return options;
    const s = await open(ks, key as Uint8Array, false);
    if (s !== undefined && !isSet(s)) return s;
    const items: KvReply[] = [];
    let last: Uint8Array | undefined;
    let examined = 0;
    if (s) {
      for await (const member of s.members(after ?? undefined)) {
        last = member;
        if (!options.match || globMatch(options.match, member)) items.push(bulk(member));
        if (++examined >= options.count) break;
      }
    }
    const cursor = examined >= options.count && last ? encodeCursor(last) : '0';
    return array([bulk(textBytes(cursor)), array(items)]);
  },
};

export const setCommands: KvCommand[] = [
  SADD,
  SREM,
  SMEMBERS,
  SISMEMBER,
  SMISMEMBER,
  SCARD,
  SPOP,
  SRANDMEMBER,
  algebra('SINTER'),
  algebra('SUNION'),
  algebra('SDIFF'),
  SSCAN,
];
