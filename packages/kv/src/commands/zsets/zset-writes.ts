import type { KvReply } from '@mindlog/proto';
import { saveCollection } from '../../model/collection.js';
import { optionName } from '../../model/expire-options.js';
import { parseFloat64, parseInteger } from '../../model/numbers.js';
import { array, bulk, double, error, errors, integer, nil, pairs } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { isZset, openZset } from './zset-open.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const ZADD_FLAGS = new Set(['NX', 'XX', 'GT', 'LT', 'CH', 'INCR']);

/** ZADD key [NX|XX] [GT|LT] [CH] [INCR] score member [score member ...] */
const ZADD: KvCommand = {
  name: 'ZADD',
  arity: -4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...rest]) {
    const flags = new Set<string>();
    let i = 0;
    while (i < rest.length && ZADD_FLAGS.has(optionName(rest[i]))) flags.add(optionName(rest[i++]));
    const args = rest.slice(i);
    if (args.length === 0 || args.length % 2 !== 0) return errors.syntax();
    if (flags.has('NX') && flags.has('XX')) {
      return error('INVALID_ARGUMENT', 'XX and NX options at the same time are not compatible');
    }
    if (
      (flags.has('GT') && flags.has('LT')) ||
      ((flags.has('GT') || flags.has('LT')) && flags.has('NX'))
    ) {
      return error(
        'INVALID_ARGUMENT',
        'GT, LT, and/or NX options at the same time are not compatible',
      );
    }
    if (flags.has('INCR') && args.length > 2) {
      return error('INVALID_ARGUMENT', 'INCR option supports a single increment-element pair');
    }
    const scores: number[] = [];
    for (let j = 0; j < args.length; j += 2) {
      const score = parseFloat64(args[j] as Uint8Array);
      if (score === undefined) return errors.notFloat();
      scores.push(score);
    }
    const z = await openZset(ks, key as Uint8Array, true);
    if (!isZset(z)) return z ?? nil();
    let added = 0;
    let changed = 0;
    let incremented: number | undefined;
    for (let j = 0; j < args.length; j += 2) {
      const member = args[j + 1] as Uint8Array;
      const old = await z.score(member);
      let next = scores[j / 2] as number;
      if (flags.has('INCR')) {
        next = (old ?? 0) + next;
        if (Number.isNaN(next))
          return error('INVALID_ARGUMENT', 'resulting score is not a number (NaN)');
      }
      if (flags.has('NX') && old !== undefined) continue;
      if (flags.has('XX') && old === undefined) continue;
      if (old !== undefined && flags.has('GT') && !(next > old)) continue;
      if (old !== undefined && flags.has('LT') && !(next < old)) continue;
      const outcome = await z.set(member, next);
      if (outcome === 'added') added++;
      if (outcome !== 'same') changed++;
      incremented = next;
    }
    saveCollection(ks, key as Uint8Array, z.header);
    if (flags.has('INCR')) return incremented === undefined ? nil() : double(incremented);
    return integer(flags.has('CH') ? changed : added);
  },
};

const ZINCRBY: KvCommand = {
  name: 'ZINCRBY',
  arity: 4,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, rawDelta, member]) {
    const delta = parseFloat64(rawDelta as Uint8Array);
    if (delta === undefined) return errors.notFloat();
    const z = await openZset(ks, key as Uint8Array, true);
    if (!isZset(z)) return z ?? nil();
    const next = ((await z.score(member as Uint8Array)) ?? 0) + delta;
    if (Number.isNaN(next))
      return error('INVALID_ARGUMENT', 'resulting score is not a number (NaN)');
    await z.set(member as Uint8Array, next);
    saveCollection(ks, key as Uint8Array, z.header);
    return double(next);
  },
};

const ZREM: KvCommand = {
  name: 'ZREM',
  arity: -3,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...members]) {
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? integer(0);
    let removed = 0;
    for (const member of members) if (await z.remove(member)) removed++;
    if (removed > 0) saveCollection(ks, key as Uint8Array, z.header);
    return integer(removed);
  },
};

const zpop = (name: 'ZPOPMIN' | 'ZPOPMAX'): KvCommand => ({
  name,
  arity: -2,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCount]) {
    const count = rawCount ? parseInteger(rawCount) : 1n;
    if (count === undefined || count < 0n) {
      return error('INVALID_ARGUMENT', 'value is out of range, must be positive');
    }
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? array([]);
    const taken: (readonly [KvReply, KvReply])[] = [];
    for await (const { member, score } of z.all(name === 'ZPOPMAX')) {
      if (BigInt(taken.length) >= count) break;
      taken.push([bulk(member), double(score)]);
    }
    for (const [member] of taken) {
      if (member.kind.case === 'bulk') await z.remove(member.kind.value);
    }
    saveCollection(ks, key as Uint8Array, z.header);
    if (!rawCount) return array(taken.flat());
    return pairs(taken);
  },
});

export const zsetWriteCommands: KvCommand[] = [
  ZADD,
  ZINCRBY,
  ZREM,
  zpop('ZPOPMIN'),
  zpop('ZPOPMAX'),
];
