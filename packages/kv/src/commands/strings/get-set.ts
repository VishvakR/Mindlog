import type { KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { expireAt, isReply, optionName } from '../../model/expire-options.js';
import { array, bulk, errors, integer, nil, ok } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { readString, writeString } from './string-values.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const EXPIRES = new Set(['EX', 'PX', 'EXAT', 'PXAT']);

const GET: KvCommand = {
  name: 'GET',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name]) {
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found)) return found;
    return found ? bulk(found.value) : nil();
  },
};

/** SET key value [NX|XX] [GET] [EX s|PX ms|EXAT ts|PXAT ms|KEEPTTL] */
const SET: KvCommand = {
  name: 'SET',
  arity: -3,
  flags: ['write', 'denyoom'],
  keys: ONE_KEY,
  async execute(ks, [name, value, ...options]) {
    let condition: 'NX' | 'XX' | undefined;
    let get = false;
    let keepTtl = false;
    let expireAtMs: bigint | undefined;
    for (let i = 0; i < options.length; i++) {
      const option = optionName(options[i]);
      if ((option === 'NX' || option === 'XX') && !condition) condition = option;
      else if (option === 'GET' && !get) get = true;
      else if (option === 'KEEPTTL' && !keepTtl && expireAtMs === undefined) keepTtl = true;
      else if (EXPIRES.has(option) && expireAtMs === undefined && !keepTtl && options[i + 1]) {
        const at = expireAt(option as 'EX', options[++i] as Uint8Array, ks.context.nowMs, 'set');
        if (isReply(at)) return at;
        expireAtMs = at;
      } else return errors.syntax();
    }
    const key = name as Uint8Array;
    const existing = await ks.header(key);
    let previous: KvReply = nil();
    if (get && existing) {
      if (existing.type !== KvType.STRING) return errors.wrongType();
      previous = bulk(existing.value);
    }
    if ((condition === 'NX' && existing) || (condition === 'XX' && !existing)) {
      return get ? previous : nil();
    }
    writeString(ks, key, value as Uint8Array, existing, {
      keepTtl,
      ...(expireAtMs === undefined ? {} : { expireAtMs }),
    });
    return get ? previous : ok();
  },
};

const SETNX: KvCommand = {
  name: 'SETNX',
  arity: 3,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name, value]) {
    const key = name as Uint8Array;
    if (await ks.header(key)) return integer(0);
    writeString(ks, key, value as Uint8Array, undefined);
    return integer(1);
  },
};

const timedSet = (command: 'SETEX' | 'PSETEX', unit: 'EX' | 'PX'): KvCommand => ({
  name: command,
  arity: 4,
  flags: ['write', 'denyoom'],
  keys: ONE_KEY,
  async execute(ks, [name, amount, value]) {
    const at = expireAt(unit, amount as Uint8Array, ks.context.nowMs, command);
    if (isReply(at)) return at;
    const key = name as Uint8Array;
    writeString(ks, key, value as Uint8Array, await ks.header(key), { expireAtMs: at });
    return ok();
  },
});

const GETDEL: KvCommand = {
  name: 'GETDEL',
  arity: 2,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name]) {
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found) || !found) return found ?? nil();
    ks.delete(name as Uint8Array, found.header);
    return bulk(found.value);
  },
};

/** GETEX key [EX s|PX ms|EXAT ts|PXAT ms|PERSIST] */
const GETEX: KvCommand = {
  name: 'GETEX',
  arity: -2,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name, ...options]) {
    let change: bigint | undefined;
    const option = optionName(options[0]);
    if (options.length === 1 && option === 'PERSIST') change = 0n;
    else if (options.length === 2 && EXPIRES.has(option)) {
      const at = expireAt(option as 'EX', options[1] as Uint8Array, ks.context.nowMs, 'getex');
      if (isReply(at)) return at;
      change = at;
    } else if (options.length !== 0) return errors.syntax();
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found) || !found) return found ?? nil();
    if (change !== undefined) {
      ks.setExpiry(name as Uint8Array, found.header, change);
      ks.write(name as Uint8Array, found.header);
    }
    return bulk(found.value);
  },
};

const MGET: KvCommand = {
  name: 'MGET',
  arity: -2,
  flags: ['readonly', 'fast'],
  keys: { first: 1, last: -1, step: 1 },
  async execute(ks, names) {
    const values = await Promise.all(
      names.map(async (name) => {
        const found = await readString(ks, name);
        return found && !isReply(found) ? bulk(found.value) : nil();
      }),
    );
    return array(values);
  },
};

const MSET: KvCommand = {
  name: 'MSET',
  arity: -3,
  flags: ['write', 'denyoom'],
  keys: { first: 1, last: -1, step: 2 },
  async execute(ks, pairs) {
    if (pairs.length % 2 !== 0) return errors.arity('mset');
    for (let i = 0; i < pairs.length; i += 2) {
      const key = pairs[i] as Uint8Array;
      writeString(ks, key, pairs[i + 1] as Uint8Array, await ks.header(key));
    }
    return ok();
  },
};

const MSETNX: KvCommand = {
  name: 'MSETNX',
  arity: -3,
  flags: ['write', 'denyoom'],
  keys: { first: 1, last: -1, step: 2 },
  async execute(ks, pairs) {
    if (pairs.length % 2 !== 0) return errors.arity('msetnx');
    for (let i = 0; i < pairs.length; i += 2) {
      if (await ks.header(pairs[i] as Uint8Array)) return integer(0);
    }
    for (let i = 0; i < pairs.length; i += 2) {
      writeString(ks, pairs[i] as Uint8Array, pairs[i + 1] as Uint8Array, undefined);
    }
    return integer(1);
  },
};

export const getSetCommands: KvCommand[] = [
  GET,
  SET,
  SETNX,
  timedSet('SETEX', 'EX'),
  timedSet('PSETEX', 'PX'),
  GETDEL,
  GETEX,
  MGET,
  MSET,
  MSETNX,
];
