import { isReply } from '../../model/expire-options.js';
import { parseInteger } from '../../model/numbers.js';
import { bulk, error, errors, integer } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { readString, writeString } from './string-values.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
/** Valkey proto-max-bulk-len default. */
const MAX_STRING = 512 * 1024 * 1024;

const APPEND: KvCommand = {
  name: 'APPEND',
  arity: 3,
  flags: ['write', 'denyoom', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name, suffix]) {
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found)) return found;
    const head = found?.value ?? new Uint8Array();
    const tail = suffix as Uint8Array;
    if (head.length + tail.length > MAX_STRING) {
      return error('INVALID_ARGUMENT', 'string exceeds maximum allowed size (proto-max-bulk-len)');
    }
    const value = new Uint8Array(head.length + tail.length);
    value.set(head);
    value.set(tail, head.length);
    writeString(ks, name as Uint8Array, value, found?.header, { keepTtl: true });
    return integer(value.length);
  },
};

const STRLEN: KvCommand = {
  name: 'STRLEN',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [name]) {
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found)) return found;
    return integer(found?.value.length ?? 0);
  },
};

const getRange = (name: 'GETRANGE' | 'SUBSTR'): KvCommand => ({
  name,
  arity: 4,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawStart, rawEnd]) {
    const start = parseInteger(rawStart as Uint8Array);
    const end = parseInteger(rawEnd as Uint8Array);
    if (start === undefined || end === undefined) return errors.notInteger();
    const found = await readString(ks, key as Uint8Array);
    if (isReply(found)) return found;
    const value = found?.value ?? new Uint8Array();
    const length = BigInt(value.length);
    if (start < 0n && end < 0n && start > end) return bulk(new Uint8Array());
    let from = start < 0n ? length + start : start;
    let to = end < 0n ? length + end : end;
    if (from < 0n) from = 0n;
    if (to < 0n) to = 0n;
    if (to >= length) to = length - 1n;
    if (length === 0n || from > to) return bulk(new Uint8Array());
    return bulk(value.slice(Number(from), Number(to) + 1));
  },
});

const SETRANGE: KvCommand = {
  name: 'SETRANGE',
  arity: 4,
  flags: ['write', 'denyoom'],
  keys: ONE_KEY,
  async execute(ks, [name, rawOffset, patch]) {
    const offset = parseInteger(rawOffset as Uint8Array);
    if (offset === undefined) return errors.notInteger();
    if (offset < 0n) return error('INVALID_ARGUMENT', 'offset is out of range');
    const found = await readString(ks, name as Uint8Array);
    if (isReply(found)) return found;
    const head = found?.value ?? new Uint8Array();
    const data = patch as Uint8Array;
    if (data.length === 0) return integer(head.length);
    const size = Math.max(head.length, Number(offset) + data.length);
    if (size > MAX_STRING) {
      return error('INVALID_ARGUMENT', 'string exceeds maximum allowed size (proto-max-bulk-len)');
    }
    const value = new Uint8Array(size);
    value.set(head);
    value.set(data, Number(offset));
    writeString(ks, name as Uint8Array, value, found?.header, { keepTtl: true });
    return integer(size);
  },
};

export const rangeCommands: KvCommand[] = [
  APPEND,
  STRLEN,
  getRange('GETRANGE'),
  getRange('SUBSTR'),
  SETRANGE,
];
