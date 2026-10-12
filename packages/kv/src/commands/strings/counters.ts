import { isReply } from '../../model/expire-options.js';
import type { Keyspace } from '../../model/keyspace.js';
import {
  INT64_MAX,
  INT64_MIN,
  formatDouble,
  parseFloat64,
  parseInteger,
  textBytes,
} from '../../model/numbers.js';
import { bulk, error, errors, integer } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { readString, writeString } from './string-values.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;

async function incrementBy(ks: Keyspace, name: Uint8Array, delta: bigint) {
  const found = await readString(ks, name);
  if (isReply(found)) return found;
  const current = found ? parseInteger(found.value) : 0n;
  if (current === undefined) return errors.notInteger();
  const next = current + delta;
  if (next > INT64_MAX || next < INT64_MIN) return errors.overflow();
  writeString(ks, name, textBytes(next.toString()), found?.header, { keepTtl: true });
  return integer(next);
}

const counter = (name: string, sign: 1n | -1n, fixed?: bigint): KvCommand => ({
  name,
  arity: fixed === undefined ? 3 : 2,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  execute(ks, [key, amount]) {
    const delta = fixed ?? parseInteger(amount ?? new Uint8Array());
    if (delta === undefined) return Promise.resolve(errors.notInteger());
    if (sign === -1n && delta === INT64_MIN) {
      return Promise.resolve(error('INVALID_ARGUMENT', 'decrement would overflow'));
    }
    return incrementBy(ks, key as Uint8Array, sign * delta);
  },
});

const INCRBYFLOAT: KvCommand = {
  name: 'INCRBYFLOAT',
  arity: 3,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name, amount]) {
    const delta = parseFloat64(amount as Uint8Array);
    if (delta === undefined) return errors.notFloat();
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found)) return found;
    const current = found ? parseFloat64(found.value) : 0;
    if (current === undefined) return errors.notFloat();
    const next = current + delta;
    if (!Number.isFinite(next)) {
      return error('INVALID_ARGUMENT', 'increment would produce NaN or Infinity');
    }
    const text = textBytes(formatDouble(next));
    writeString(ks, name as Uint8Array, text, found?.header, { keepTtl: true });
    return bulk(text);
  },
};

export const counterCommands: KvCommand[] = [
  counter('INCR', 1n, 1n),
  counter('DECR', -1n, 1n),
  counter('INCRBY', 1n),
  counter('DECRBY', -1n),
  INCRBYFLOAT,
];
