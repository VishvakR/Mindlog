import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { KvService } from '../kv/kv-service.js';
import type { Session } from '../session/session.js';
import { allUtf8, toBytes, toText } from './byte-text.js';
import type {
  Encoding,
  KeyDetail,
  KeyQuery,
  KeyType,
  KeyValue,
  ScanQuery,
  ScanResult,
  WriteKeyBody,
} from './schemas.js';

type Arg = string | Uint8Array;
type Reply = Result<KvReply, MindlogError>;

const encoder = new TextEncoder();
const TYPES: Readonly<Record<string, KeyType>> = {
  string: 'string',
  hash: 'hash',
  list: 'list',
  set: 'set',
  zset: 'zset',
  'ReJSON-RL': 'json',
};

const bytesOf = (r: KvReply): Uint8Array =>
  r.kind.case === 'bulk'
    ? r.kind.value
    : encoder.encode(r.kind.case === 'simple' ? r.kind.value : '');
const itemsOf = (r: KvReply): KvReply[] =>
  r.kind.case === 'array' || r.kind.case === 'set' ? r.kind.value.items : [];
const asError = (e: { code: string; message: string }): MindlogError =>
  mindlogError(e.code as MindlogError['code'], e.message);
const intOf = (r: KvReply): number => (r.kind.case === 'integer' ? Number(r.kind.value) : 0);

/**
 * Typed key access for the dashboard and REST API (PLAN 24 phase 2), built on
 * `KvService.execute` so every read and write takes the same path as RESP.
 */
export class KvBrowser {
  constructor(private readonly service: KvService) {}

  async #run(session: Session, args: readonly Arg[]): Promise<Reply> {
    const reply = await this.service.execute(
      session,
      args.map((a) => (typeof a === 'string' ? encoder.encode(a) : a)),
    );
    return reply.kind.case === 'error' ? err(asError(reply.kind.value)) : ok(reply);
  }

  async #ttl(session: Session, key: Uint8Array): Promise<Result<number | null, MindlogError>> {
    const pttl = await this.#run(session, ['PTTL', key]);
    if (!pttl.ok) return pttl;
    const ms = intOf(pttl.value);
    return ok(ms < 0 ? null : ms);
  }

  async #type(
    session: Session,
    key: Uint8Array,
  ): Promise<Result<KeyType | undefined, MindlogError>> {
    const type = await this.#run(session, ['TYPE', key]);
    if (!type.ok) return type;
    return ok(TYPES[new TextDecoder().decode(bytesOf(type.value))]);
  }

  /** One SCAN page with each key's type and TTL. */
  async scan(session: Session, query: ScanQuery): Promise<Result<ScanResult, MindlogError>> {
    const args: Arg[] = ['SCAN', query.cursor, 'COUNT', String(query.count)];
    if (query.match) args.push('MATCH', query.match);
    if (query.type) args.push('TYPE', query.type === 'json' ? 'ReJSON-RL' : query.type);
    const page = await this.#run(session, args);
    if (!page.ok) return page;
    const [cursor, names] = itemsOf(page.value);
    const keys: ScanResult['keys'] = [];
    for (const item of names ? itemsOf(names) : []) {
      const key = bytesOf(item);
      const type = await this.#type(session, key);
      if (!type.ok) return type;
      if (!type.value) continue; // expired or deleted since SCAN
      const ttl = await this.#ttl(session, key);
      if (!ttl.ok) return ttl;
      const encoding: Encoding = allUtf8([key]) ? 'utf8' : 'base64';
      keys.push({ key: toText(key, encoding), encoding, type: type.value, ttlMs: ttl.value });
    }
    return ok({ cursor: cursor ? new TextDecoder().decode(bytesOf(cursor)) : '0', keys });
  }

  /** Reads a key's value, at most `limit` elements of a collection; NOT_FOUND when absent. */
  async read(
    session: Session,
    key: Uint8Array,
    query: KeyQuery,
  ): Promise<Result<KeyDetail, MindlogError>> {
    const type = await this.#type(session, key);
    if (!type.ok) return type;
    if (!type.value) return err(mindlogError('NOT_FOUND', 'key does not exist'));
    const last = String(query.limit - 1);
    const reads: Record<KeyType, [Arg[], Arg[] | undefined]> = {
      string: [['GET', key], undefined],
      json: [['JSON.GET', key], undefined],
      hash: [
        ['HSCAN', key, '0', 'COUNT', String(query.limit)],
        ['HLEN', key],
      ],
      set: [
        ['SSCAN', key, '0', 'COUNT', String(query.limit)],
        ['SCARD', key],
      ],
      list: [
        ['LRANGE', key, '0', last],
        ['LLEN', key],
      ],
      zset: [
        ['ZRANGE', key, '0', last, 'WITHSCORES'],
        ['ZCARD', key],
      ],
    };
    const [readArgs, lengthArgs] = reads[type.value];
    const value = await this.#run(session, readArgs);
    if (!value.ok) return value;
    const length = lengthArgs ? await this.#run(session, lengthArgs) : undefined;
    if (length && !length.ok) return length;
    const ttl = await this.#ttl(session, key);
    if (!ttl.ok) return ttl;
    const decoded = decodeValue(type.value, value.value);
    const count = length ? intOf(length.value) : 1;
    return ok({
      ...decoded.typed,
      key: toText(key, query.encoding),
      encoding: decoded.encoding,
      ttlMs: ttl.value,
      length: count,
      truncated: count > decoded.elements,
    });
  }

  /** Replaces a key's value and TTL in one transaction (MULTI/EXEC). */
  async write(
    session: Session,
    key: Uint8Array,
    body: WriteKeyBody,
  ): Promise<Result<void, MindlogError>> {
    const enc = body.encoding ?? 'utf8';
    const commands: Arg[][] = [['MULTI'], ['DEL', key], writeArgs(key, body, enc)];
    if (body.ttlMs) commands.push(['PEXPIRE', key, String(body.ttlMs)]);
    commands.push(['EXEC']);
    let last: KvReply | undefined;
    for (const args of commands) {
      const reply = await this.#run(session, args);
      if (!reply.ok) {
        if (args[0] !== 'EXEC') await this.#run(session, ['DISCARD']);
        return reply;
      }
      last = reply.value;
    }
    const failed = last ? itemsOf(last).find((r) => r.kind.case === 'error') : undefined;
    return failed?.kind.case === 'error' ? err(asError(failed.kind.value)) : ok(undefined);
  }

  /** Deletes a key; NOT_FOUND when it did not exist. */
  async remove(session: Session, key: Uint8Array): Promise<Result<void, MindlogError>> {
    const removed = await this.#run(session, ['DEL', key]);
    if (!removed.ok) return removed;
    return intOf(removed.value) === 0
      ? err(mindlogError('NOT_FOUND', 'key does not exist'))
      : ok(undefined);
  }

  /** Sets (PEXPIRE) or clears (PERSIST) a key's TTL; NOT_FOUND when the key is absent. */
  async setTtl(
    session: Session,
    key: Uint8Array,
    ttlMs: number | null,
  ): Promise<Result<void, MindlogError>> {
    const changed = await this.#run(
      session,
      ttlMs === null ? ['PERSIST', key] : ['PEXPIRE', key, String(ttlMs)],
    );
    if (!changed.ok) return changed;
    if (intOf(changed.value) === 1) return ok(undefined);
    const exists = await this.#run(session, ['EXISTS', key]);
    if (!exists.ok) return exists;
    return intOf(exists.value) === 0
      ? err(mindlogError('NOT_FOUND', 'key does not exist'))
      : ok(undefined);
  }
}

function writeArgs(key: Uint8Array, body: KeyValue, enc: Encoding): Arg[] {
  const b = (s: string) => toBytes(s, enc);
  switch (body.type) {
    case 'string':
      return ['SET', key, b(body.value)];
    case 'json':
      return ['JSON.SET', key, '$', JSON.stringify(body.value)];
    case 'hash':
      return ['HSET', key, ...body.value.flatMap((e) => [b(e.field), b(e.value)])];
    case 'list':
      return ['RPUSH', key, ...body.value.map(b)];
    case 'set':
      return ['SADD', key, ...body.value.map(b)];
    case 'zset':
      return ['ZADD', key, ...body.value.flatMap((e) => [String(e.score), b(e.member)])];
  }
}

interface Decoded {
  typed: KeyValue;
  elements: number;
  encoding: Encoding;
}

const scoreOf = (r: KvReply): number =>
  r.kind.case === 'double' ? r.kind.value : Number(new TextDecoder().decode(bytesOf(r)));

function decodeValue(type: KeyType, reply: KvReply): Decoded {
  if (type === 'json') {
    const value = JSON.parse(new TextDecoder().decode(bytesOf(reply))) as KeyValue['value'];
    return { typed: { type, value }, elements: 1, encoding: 'utf8' };
  }
  if (type === 'zset') {
    const items = itemsOf(reply).map((pair) => itemsOf(pair));
    const members = items.map(([m]) => (m ? bytesOf(m) : new Uint8Array()));
    const encoding: Encoding = allUtf8(members) ? 'utf8' : 'base64';
    const value = items.map(([, score], i) => ({
      member: toText(members[i] as Uint8Array, encoding),
      score: score ? scoreOf(score) : 0,
    }));
    return { typed: { type, value }, elements: value.length, encoding };
  }
  // HSCAN and SSCAN reply [cursor, items]; GET a bulk; LRANGE the items.
  const bytes =
    type === 'string'
      ? [bytesOf(reply)]
      : (type === 'list' ? itemsOf(reply) : itemsOf(itemsOf(reply)[1] ?? reply)).map(bytesOf);
  const encoding: Encoding = allUtf8(bytes) ? 'utf8' : 'base64';
  const texts = bytes.map((b) => toText(b, encoding));
  switch (type) {
    case 'string':
      return { typed: { type, value: texts[0] ?? '' }, elements: 1, encoding };
    case 'hash': {
      const value: { field: string; value: string }[] = [];
      for (let i = 0; i + 1 < texts.length; i += 2) {
        value.push({ field: texts[i] as string, value: texts[i + 1] as string });
      }
      return { typed: { type, value }, elements: value.length, encoding };
    }
    default:
      return { typed: { type, value: texts }, elements: texts.length, encoding };
  }
}
