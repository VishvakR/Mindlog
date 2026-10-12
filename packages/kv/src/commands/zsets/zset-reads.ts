import type { KvReply } from '@mindlog/proto';
import { optionName } from '../../model/expire-options.js';
import { globMatch } from '../../model/glob.js';
import type { Keyspace } from '../../model/keyspace.js';
import { formatDouble, parseInteger, textBytes } from '../../model/numbers.js';
import { decodeCursor, encodeCursor } from '../../model/scan-cursor.js';
import { array, bulk, double, error, errors, integer, nil, pairs } from '../../model/replies.js';
import { parseScanOptions } from '../keys/scan.js';
import type { KvCommand } from '../kv-command.js';
import type { LexBound, ScoreBound } from './zset-bounds.js';
import { parseLexBound, parseScoreBound } from './zset-bounds.js';
import { isZset, openZset } from './zset-open.js';
import type { Scored, ZsetOps } from './zset-ops.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const NOT_FLOAT_RANGE = () => error('INVALID_ARGUMENT', 'min or max is not a float');
const NOT_LEX_RANGE = () => error('INVALID_ARGUMENT', 'min or max not valid string range item');

interface RangeRequest {
  readonly by: 'rank' | 'score' | 'lex';
  readonly reverse: boolean;
  readonly withScores: boolean;
  readonly offset: number;
  readonly limit: number;
}

function render(items: Scored[], withScores: boolean): KvReply {
  if (!withScores) return array(items.map((i) => bulk(i.member)));
  return pairs(items.map((i) => [bulk(i.member), double(i.score)] as const));
}

async function collect(
  source: AsyncIterable<Scored>,
  offset: number,
  limit: number,
): Promise<Scored[]> {
  const out: Scored[] = [];
  let skipped = 0;
  for await (const item of source) {
    if (skipped < offset) {
      skipped++;
      continue;
    }
    if (limit >= 0 && out.length >= limit) break;
    out.push(item);
  }
  return out;
}

/** Runs one ZRANGE-family request against `z` with raw start/stop arguments. */
async function range(
  z: ZsetOps,
  req: RangeRequest,
  start: Uint8Array,
  stop: Uint8Array,
): Promise<KvReply> {
  if (req.by === 'rank') {
    const a = parseInteger(start);
    const b = parseInteger(stop);
    if (a === undefined || b === undefined) return errors.notInteger();
    const length = z.header.count;
    let from = a < 0n ? length + a : a;
    let to = b < 0n ? length + b : b;
    if (from < 0n) from = 0n;
    if (to >= length) to = length - 1n;
    if (from > to) return render([], req.withScores);
    const items = await collect(z.all(req.reverse), Number(from), Number(to - from + 1n));
    return render(items, req.withScores);
  }
  if (req.by === 'score') {
    const first = parseScoreBound(start);
    const second = parseScoreBound(stop);
    if (!first || !second) return NOT_FLOAT_RANGE();
    const [min, max]: [ScoreBound, ScoreBound] = req.reverse ? [second, first] : [first, second];
    return render(
      await collect(z.byScore(min, max, req.reverse), req.offset, req.limit),
      req.withScores,
    );
  }
  const first = parseLexBound(start);
  const second = parseLexBound(stop);
  if (!first || !second) return NOT_LEX_RANGE();
  const [min, max]: [LexBound, LexBound] = req.reverse ? [second, first] : [first, second];
  return render(await collect(z.byLex(min, max, req.reverse), req.offset, req.limit), false);
}

/** Parses trailing options shared by the ZRANGE family. */
function parseRangeOptions(
  options: readonly Uint8Array[],
  base: Partial<RangeRequest>,
  allow: { by: boolean; rev: boolean; limit: boolean },
): RangeRequest | KvReply {
  let req: RangeRequest = {
    by: 'rank',
    reverse: false,
    withScores: false,
    offset: 0,
    limit: -1,
    ...base,
  };
  let limited = false;
  for (let i = 0; i < options.length; i++) {
    const option = optionName(options[i]);
    if (option === 'WITHSCORES') req = { ...req, withScores: true };
    else if (allow.by && option === 'BYSCORE') req = { ...req, by: 'score' };
    else if (allow.by && option === 'BYLEX') req = { ...req, by: 'lex' };
    else if (allow.rev && option === 'REV') req = { ...req, reverse: true };
    else if (allow.limit && option === 'LIMIT' && options[i + 2]) {
      const offset = parseInteger(options[++i] as Uint8Array);
      const limit = parseInteger(options[++i] as Uint8Array);
      if (offset === undefined || limit === undefined) return errors.notInteger();
      req = { ...req, offset: Number(offset < 0n ? 0n : offset), limit: Number(limit) };
      limited = true;
    } else return errors.syntax();
  }
  if (limited && req.by === 'rank') {
    return error(
      'INVALID_ARGUMENT',
      'syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX',
    );
  }
  if (req.withScores && req.by === 'lex') {
    return error(
      'INVALID_ARGUMENT',
      'syntax error, WITHSCORES not supported in combination with BYLEX',
    );
  }
  return req;
}

const rangeCommand = (
  name: string,
  base: Partial<RangeRequest>,
  allow: { by: boolean; rev: boolean; limit: boolean },
): KvCommand => ({
  name,
  arity: -4,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks: Keyspace, [key, start, stop, ...options]) {
    const req = parseRangeOptions(options, base, allow);
    if ('kind' in req) return req;
    const z = await openZset(ks, key as Uint8Array, false);
    if (z !== undefined && !isZset(z)) return z;
    if (!z) return req.withScores ? pairs([]) : array([]);
    return range(z, req, start as Uint8Array, stop as Uint8Array);
  },
});

const ZSCORE: KvCommand = {
  name: 'ZSCORE',
  arity: 3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, member]) {
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? nil();
    const score = await z.score(member as Uint8Array);
    return score === undefined ? nil() : double(score);
  },
};

const ZMSCORE: KvCommand = {
  name: 'ZMSCORE',
  arity: -3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, ...members]) {
    const z = await openZset(ks, key as Uint8Array, false);
    if (z !== undefined && !isZset(z)) return z;
    const scores = z
      ? await Promise.all(members.map((m) => z.score(m)))
      : members.map(() => undefined);
    return array(scores.map((s) => (s === undefined ? nil() : double(s))));
  },
};

const ZCARD: KvCommand = {
  name: 'ZCARD',
  arity: 2,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key]) {
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? integer(0);
    return integer(z.header.count);
  },
};

const ZCOUNT: KvCommand = {
  name: 'ZCOUNT',
  arity: 4,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, rawMin, rawMax]) {
    const min = parseScoreBound(rawMin as Uint8Array);
    const max = parseScoreBound(rawMax as Uint8Array);
    if (!min || !max) return NOT_FLOAT_RANGE();
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? integer(0);
    let count = 0;
    for await (const _ of z.byScore(min, max)) count++;
    return integer(count);
  },
};

const rank = (name: 'ZRANK' | 'ZREVRANK'): KvCommand => ({
  name,
  arity: -3,
  flags: ['readonly', 'fast'],
  keys: ONE_KEY,
  async execute(ks, [key, member, option]) {
    const withScore = option !== undefined && optionName(option) === 'WITHSCORE';
    if (option !== undefined && !withScore) return errors.syntax();
    const z = await openZset(ks, key as Uint8Array, false);
    if (!isZset(z)) return z ?? nil();
    const position = await z.rank(member as Uint8Array, name === 'ZREVRANK');
    if (position === undefined) return nil();
    if (!withScore) return integer(position);
    return array([integer(position), double((await z.score(member as Uint8Array)) ?? 0)]);
  },
});

const ZSCAN: KvCommand = {
  name: 'ZSCAN',
  arity: -3,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, rawCursor, ...rest]) {
    const after = decodeCursor(rawCursor as Uint8Array);
    if (after === undefined) return error('INVALID_ARGUMENT', 'invalid cursor');
    const options = parseScanOptions(rest, false);
    if ('kind' in options) return options;
    const z = await openZset(ks, key as Uint8Array, false);
    if (z !== undefined && !isZset(z)) return z;
    const items: KvReply[] = [];
    let last: Uint8Array | undefined;
    let examined = 0;
    if (z) {
      const start = after
        ? { kind: 'value' as const, value: after, exclusive: true }
        : { kind: 'min' as const };
      for await (const { member, score } of z.byLex(start, { kind: 'max' })) {
        last = member;
        if (!options.match || globMatch(options.match, member))
          items.push(bulk(member), bulk(textBytes(formatDouble(score))));
        if (++examined >= options.count) break;
      }
    }
    const cursor = examined >= options.count && last ? encodeCursor(last) : '0';
    return array([bulk(textBytes(cursor)), array(items)]);
  },
};

const ALL = { by: true, rev: true, limit: true };
const SCORE_ONLY = { by: false, rev: false, limit: true };
const RANK_ONLY = { by: false, rev: false, limit: false };

export const zsetReadCommands: KvCommand[] = [
  rangeCommand('ZRANGE', {}, ALL),
  rangeCommand('ZREVRANGE', { reverse: true }, RANK_ONLY),
  rangeCommand('ZRANGEBYSCORE', { by: 'score' }, SCORE_ONLY),
  rangeCommand('ZREVRANGEBYSCORE', { by: 'score', reverse: true }, SCORE_ONLY),
  rangeCommand('ZRANGEBYLEX', { by: 'lex' }, SCORE_ONLY),
  rangeCommand('ZREVRANGEBYLEX', { by: 'lex', reverse: true }, SCORE_ONLY),
  ZSCORE,
  ZMSCORE,
  ZCARD,
  ZCOUNT,
  rank('ZRANK'),
  rank('ZREVRANK'),
  ZSCAN,
];
