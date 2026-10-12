import type { KvReply } from '@mindlog/proto';
import { parseInteger } from './numbers.js';
import { error } from './replies.js';

const decoder = new TextDecoder();
const MAX_EXPIRE_MS = 2n ** 48n - 1n;

/** Converts an EX/PX/EXAT/PXAT argument to an absolute ms time, or an error reply. */
export function expireAt(
  unit: 'EX' | 'PX' | 'EXAT' | 'PXAT',
  raw: Uint8Array,
  nowMs: bigint,
  command: string,
): bigint | KvReply {
  const invalid = error(
    'INVALID_ARGUMENT',
    `invalid expire time in '${command.toLowerCase()}' command`,
  );
  const amount = parseInteger(raw);
  if (amount === undefined)
    return error('INVALID_ARGUMENT', 'value is not an integer or out of range');
  if (amount <= 0n) return invalid;
  const ms =
    unit === 'EX'
      ? nowMs + amount * 1000n
      : unit === 'PX'
        ? nowMs + amount
        : unit === 'EXAT'
          ? amount * 1000n
          : amount;
  return ms > MAX_EXPIRE_MS ? invalid : ms;
}

export const optionName = (raw: Uint8Array | undefined): string =>
  raw ? decoder.decode(raw).toUpperCase() : '';

export const isReply = (value: unknown): value is KvReply =>
  typeof value === 'object' && value !== null && 'kind' in value;
