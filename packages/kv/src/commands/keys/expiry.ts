import type { KvReply } from '@mindlog/proto';
import { optionName } from '../../model/expire-options.js';
import type { Keyspace } from '../../model/keyspace.js';
import { parseInteger } from '../../model/numbers.js';
import { error, errors, integer } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const MAX_EXPIRE_MS = 2n ** 48n - 1n;

type Unit = 'relative-s' | 'relative-ms' | 'absolute-s' | 'absolute-ms';

function toAbsoluteMs(unit: Unit, amount: bigint, nowMs: bigint): bigint {
  switch (unit) {
    case 'relative-s':
      return nowMs + amount * 1000n;
    case 'relative-ms':
      return nowMs + amount;
    case 'absolute-s':
      return amount * 1000n;
    case 'absolute-ms':
      return amount;
  }
}

/** Parses NX|XX|GT|LT (Valkey expireGenericCommand rules). */
function parseCondition(options: readonly Uint8Array[]): string | KvReply {
  const flags = new Set(options.map(optionName));
  for (const flag of flags) if (!['NX', 'XX', 'GT', 'LT'].includes(flag)) return errors.syntax();
  if (flags.has('NX') && (flags.has('XX') || flags.has('GT') || flags.has('LT'))) {
    return error(
      'INVALID_ARGUMENT',
      'NX and XX, GT or LT options at the same time are not compatible',
    );
  }
  if (flags.has('GT') && flags.has('LT')) {
    return error('INVALID_ARGUMENT', 'GT and LT options at the same time are not compatible');
  }
  return [...flags].join('');
}

const expireCommand = (name: string, unit: Unit): KvCommand => ({
  name,
  arity: -3,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, rawAmount, ...options]) {
    const amount = parseInteger(rawAmount as Uint8Array);
    if (amount === undefined) return errors.notInteger();
    const condition = parseCondition(options);
    if (typeof condition !== 'string') return condition;
    const at = toAbsoluteMs(unit, amount, ks.context.nowMs);
    if (at > MAX_EXPIRE_MS) {
      return error('INVALID_ARGUMENT', `invalid expire time in '${name.toLowerCase()}' command`);
    }
    const target = key as Uint8Array;
    const header = await ks.header(target);
    if (!header) return integer(0);
    const current = header.expireAtMs;
    if (condition.includes('NX') && current !== 0n) return integer(0);
    if (condition.includes('XX') && current === 0n) return integer(0);
    if (condition.includes('GT') && (current === 0n || at <= current)) return integer(0);
    if (condition.includes('LT') && current !== 0n && at >= current) return integer(0);
    if (at <= ks.context.nowMs) {
      ks.delete(target, header);
      return integer(1);
    }
    ks.setExpiry(target, header, at);
    ks.write(target, header);
    return integer(1);
  },
});

const remaining = (name: string, scale: bigint, absolute: boolean): KvCommand => ({
  name,
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks: Keyspace, [key]) {
    const header = await ks.header(key as Uint8Array);
    if (!header) return integer(-2);
    if (header.expireAtMs === 0n) return integer(-1);
    if (absolute) return integer(header.expireAtMs / scale);
    const left = header.expireAtMs - ks.context.nowMs;
    return integer(scale === 1n ? left : (left + 500n) / 1000n);
  },
});

const PERSIST: KvCommand = {
  name: 'PERSIST',
  arity: 2,
  flags: ['write', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const header = await ks.header(key as Uint8Array);
    if (!header || header.expireAtMs === 0n) return integer(0);
    ks.setExpiry(key as Uint8Array, header, 0n);
    ks.write(key as Uint8Array, header);
    return integer(1);
  },
};

export const expiryCommands: KvCommand[] = [
  expireCommand('EXPIRE', 'relative-s'),
  expireCommand('PEXPIRE', 'relative-ms'),
  expireCommand('EXPIREAT', 'absolute-s'),
  expireCommand('PEXPIREAT', 'absolute-ms'),
  remaining('TTL', 1000n, false),
  remaining('PTTL', 1n, false),
  remaining('EXPIRETIME', 1000n, true),
  remaining('PEXPIRETIME', 1n, true),
  PERSIST,
];
