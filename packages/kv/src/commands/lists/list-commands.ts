import type { KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { isHeader, openCollection, saveCollection } from '../../model/collection.js';
import type { Keyspace } from '../../model/keyspace.js';
import { parseInteger } from '../../model/numbers.js';
import { array, bulk, error, errors, integer, nil, ok } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { ListOps } from './list-ops.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;

async function open(
  ks: Keyspace,
  name: Uint8Array,
  create: boolean,
): Promise<ListOps | undefined | KvReply> {
  const header = await openCollection(ks, name, KvType.LIST, create);
  return isHeader(header) ? new ListOps(ks, name, header) : header;
}

const isList = (v: ListOps | undefined | KvReply): v is ListOps => v instanceof ListOps;

/** Clamps Redis start/stop indexes to seqs; undefined when the range is empty. */
function window(list: ListOps, start: bigint, stop: bigint): [bigint, bigint] | undefined {
  const length = list.length;
  let from = start < 0n ? length + start : start;
  let to = stop < 0n ? length + stop : stop;
  if (from < 0n) from = 0n;
  if (to >= length) to = length - 1n;
  if (from > to || from >= length) return undefined;
  return [list.header.listHead + from, list.header.listHead + to];
}

const push = (name: string, side: 'left' | 'right', onlyIfExists: boolean): KvCommand => ({
  name,
  arity: -3,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...values]) {
    const list = await open(ks, key as Uint8Array, !onlyIfExists);
    if (!isList(list)) return list ?? integer(0);
    for (const value of values) {
      if (side === 'left') list.pushLeft(value);
      else list.pushRight(value);
    }
    saveCollection(ks, key as Uint8Array, list.header);
    return integer(list.length);
  },
});

const pop = (name: string, side: 'left' | 'right'): KvCommand => ({
  name,
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
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? nil();
    const take = count === undefined ? 1n : count;
    const values: KvReply[] = [];
    for (let i = 0n; i < take && list.length > 0n; i++) {
      const value = side === 'left' ? await list.popLeft() : await list.popRight();
      if (value) values.push(bulk(value));
    }
    saveCollection(ks, key as Uint8Array, list.header);
    if (count === undefined) return values[0] ?? nil();
    return array(values);
  },
});

const LRANGE: KvCommand = {
  name: 'LRANGE',
  arity: 4,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawStart, rawStop]) {
    const start = parseInteger(rawStart as Uint8Array);
    const stop = parseInteger(rawStop as Uint8Array);
    if (start === undefined || stop === undefined) return errors.notInteger();
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? array([]);
    const seqs = window(list, start, stop);
    return array(seqs ? (await list.range(...seqs)).map(bulk) : []);
  },
};

const LLEN: KvCommand = {
  name: 'LLEN',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? integer(0);
    return integer(list.length);
  },
};

const LINDEX: KvCommand = {
  name: 'LINDEX',
  arity: 3,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawIndex]) {
    const index = parseInteger(rawIndex as Uint8Array);
    if (index === undefined) return errors.notInteger();
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? nil();
    const seq = list.seqOf(index);
    const value = seq === undefined ? undefined : await list.get(seq);
    return value ? bulk(value) : nil();
  },
};

const LSET: KvCommand = {
  name: 'LSET',
  arity: 4,
  flags: ['write', 'denyoom'],
  keys: ONE_KEY,
  async execute(ks, [key, rawIndex, value]) {
    const index = parseInteger(rawIndex as Uint8Array);
    if (index === undefined) return errors.notInteger();
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? errors.noSuchKey();
    const seq = list.seqOf(index);
    if (seq === undefined) return errors.indexOutOfRange();
    list.set(seq, value as Uint8Array);
    saveCollection(ks, key as Uint8Array, list.header);
    return ok();
  },
};

const LTRIM: KvCommand = {
  name: 'LTRIM',
  arity: 4,
  flags: ['write'],
  keys: ONE_KEY,
  async execute(ks, [key, rawStart, rawStop]) {
    const start = parseInteger(rawStart as Uint8Array);
    const stop = parseInteger(rawStop as Uint8Array);
    if (start === undefined || stop === undefined) return errors.notInteger();
    const list = await open(ks, key as Uint8Array, false);
    if (!isList(list)) return list ?? ok();
    const seqs = window(list, start, stop);
    if (seqs) list.trim(...seqs);
    else list.trim(1n, 0n);
    saveCollection(ks, key as Uint8Array, list.header);
    return ok();
  },
};

export const listCommands: KvCommand[] = [
  push('LPUSH', 'left', false),
  push('RPUSH', 'right', false),
  push('LPUSHX', 'left', true),
  push('RPUSHX', 'right', true),
  pop('LPOP', 'left'),
  pop('RPOP', 'right'),
  LRANGE,
  LLEN,
  LINDEX,
  LSET,
  LTRIM,
];
