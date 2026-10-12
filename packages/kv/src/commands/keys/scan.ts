import type { KvReply } from '@mindlog/proto';
import { optionName } from '../../model/expire-options.js';
import { globMatch } from '../../model/glob.js';
import { liveKeys } from '../../model/key-iterator.js';
import { parseInteger } from '../../model/numbers.js';
import { decodeCursor, encodeCursor } from '../../model/scan-cursor.js';
import { array, bulk, error, errors } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import { TYPE_NAMES } from './key-commands.js';

/** Upper bound for KEYS: beyond it the client must use SCAN (PLAN 20: no unbounded scans). */
export const KEYS_LIMIT = 100_000;
const decoder = new TextDecoder();

export interface ScanOptions {
  readonly match?: Uint8Array;
  readonly count: number;
  readonly type?: string;
}

/** Parses `[MATCH pattern] [COUNT n] [TYPE t]` shared by SCAN and the collection scans. */
export function parseScanOptions(
  options: readonly Uint8Array[],
  allowType: boolean,
): ScanOptions | KvReply {
  let match: Uint8Array | undefined;
  let count = 10;
  let type: string | undefined;
  for (let i = 0; i < options.length; i += 2) {
    const option = optionName(options[i]);
    const value = options[i + 1];
    if (!value) return errors.syntax();
    if (option === 'MATCH') match = value;
    else if (option === 'COUNT') {
      const n = parseInteger(value);
      if (n === undefined) return errors.notInteger();
      if (n < 1n) return errors.syntax();
      count = Number(n > 100_000n ? 100_000n : n);
    } else if (option === 'TYPE' && allowType) type = decoder.decode(value).toLowerCase();
    else return errors.syntax();
  }
  return { count, ...(match ? { match } : {}), ...(type ? { type } : {}) };
}

const SCAN: KvCommand = {
  name: 'SCAN',
  arity: -2,
  flags: ['readonly'],
  async execute(ks, [rawCursor, ...rest]) {
    const after = decodeCursor(rawCursor as Uint8Array);
    if (after === undefined) return error('INVALID_ARGUMENT', 'invalid cursor');
    const options = parseScanOptions(rest, true);
    if ('kind' in options) return options;
    const found: KvReply[] = [];
    let last: Uint8Array | undefined;
    let examined = 0;
    for await (const { name, header } of liveKeys(ks, after ?? undefined)) {
      last = name;
      examined++;
      const typeOk = !options.type || TYPE_NAMES[header.type].toLowerCase() === options.type;
      if (typeOk && (!options.match || globMatch(options.match, name))) found.push(bulk(name));
      if (examined >= options.count) break;
    }
    const cursor = examined >= options.count && last ? encodeCursor(last) : '0';
    return array([bulk(new TextEncoder().encode(cursor)), array(found)]);
  },
};

const KEYS: KvCommand = {
  name: 'KEYS',
  arity: 2,
  flags: ['readonly'],
  async execute(ks, [pattern]) {
    const found: KvReply[] = [];
    let examined = 0;
    for await (const { name } of liveKeys(ks)) {
      if (++examined > KEYS_LIMIT) {
        return error('INVALID_ARGUMENT', `KEYS would scan more than ${KEYS_LIMIT} keys; use SCAN`);
      }
      if (globMatch(pattern as Uint8Array, name)) found.push(bulk(name));
    }
    return array(found);
  },
};

export const scanCommands: KvCommand[] = [SCAN, KEYS];
