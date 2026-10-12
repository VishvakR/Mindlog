import type { KvHeader, KvReply } from '@mindlog/proto';
import { KvType } from '@mindlog/proto';
import { optionName } from '../../model/expire-options.js';
import type { Keyspace } from '../../model/keyspace.js';
import { array, bulk, error, errors, integer, nil, ok } from '../../model/replies.js';
import type { KvCommand } from '../kv-command.js';
import type { Json, JsonPath } from './json-path.js';
import { deleteAt, getAt, parseJsonPath, setAt } from './json-path.js';

const ONE_KEY = { first: 1, last: 1, step: 1 } as const;
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const text = (raw: Uint8Array) => decoder.decode(raw);
const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value));

async function readJson(
  ks: Keyspace,
  name: Uint8Array,
): Promise<{ header: KvHeader; root: Json } | undefined | KvReply> {
  const header = await ks.header(name);
  if (!header) return undefined;
  if (header.type !== KvType.JSON) return errors.wrongType();
  return { header, root: JSON.parse(text(header.value)) as Json };
}

const isDoc = (
  v: { header: KvHeader; root: Json } | undefined | KvReply,
): v is { header: KvHeader; root: Json } => v !== undefined && 'root' in v;

function path(raw: Uint8Array | undefined): JsonPath | KvReply {
  const parsed = parseJsonPath(raw ? text(raw) : '$');
  return parsed ?? error('INVALID_ARGUMENT', `invalid JSON path '${raw ? text(raw) : ''}'`);
}

/** RedisJSON reply for one path: `$` paths give an array of matches, legacy paths the value. */
function select(root: Json, p: JsonPath): Json[] | Json | undefined {
  const found = getAt(root, p.segments);
  if (p.jsonPath) return found === undefined ? [] : [found];
  return found;
}

const SET: KvCommand = {
  name: 'JSON.SET',
  arity: -4,
  flags: ['write', 'denyoom'],
  keys: ONE_KEY,
  async execute(ks, [key, rawPath, rawValue, rawCondition]) {
    const p = path(rawPath);
    if ('kind' in p) return p;
    const condition = rawCondition ? optionName(rawCondition) : undefined;
    if (condition !== undefined && condition !== 'NX' && condition !== 'XX') return errors.syntax();
    let value: Json;
    try {
      value = JSON.parse(text(rawValue as Uint8Array)) as Json;
    } catch {
      return error('INVALID_ARGUMENT', 'expected a valid JSON value');
    }
    const name = key as Uint8Array;
    const doc = await readJson(ks, name);
    if (doc !== undefined && !isDoc(doc)) return doc;
    const exists = doc !== undefined && getAt(doc.root, p.segments) !== undefined;
    if ((condition === 'NX' && exists) || (condition === 'XX' && !exists)) return nil();
    if (p.segments.length === 0) {
      const header = doc?.header ?? ks.fresh(KvType.JSON);
      header.value = jsonBytes(value);
      ks.write(name, header);
      return ok();
    }
    if (!doc) return error('INVALID_ARGUMENT', 'new objects must be created at the root');
    if (!setAt(doc.root, p.segments, value)) return nil();
    doc.header.value = jsonBytes(doc.root);
    ks.write(name, doc.header);
    return ok();
  },
};

const GET: KvCommand = {
  name: 'JSON.GET',
  arity: -2,
  flags: ['readonly'],
  keys: ONE_KEY,
  async execute(ks, [key, ...rawPaths]) {
    const doc = await readJson(ks, key as Uint8Array);
    if (!isDoc(doc)) return doc ?? nil();
    if (rawPaths.length === 0) return bulk(jsonBytes(doc.root));
    const paths: JsonPath[] = [];
    for (const raw of rawPaths) {
      const p = path(raw);
      if ('kind' in p) return p;
      paths.push(p);
    }
    if (paths.length === 1) {
      const result = select(doc.root, paths[0] as JsonPath);
      return result === undefined ? nil() : bulk(jsonBytes(result));
    }
    const combined: Record<string, unknown> = {};
    for (const [i, p] of paths.entries())
      combined[text(rawPaths[i] as Uint8Array)] = select(doc.root, p);
    return bulk(jsonBytes(combined));
  },
};

const DEL: KvCommand = {
  name: 'JSON.DEL',
  arity: -2,
  flags: ['write'],
  keys: ONE_KEY,
  async execute(ks, [key, rawPath]) {
    const p = path(rawPath);
    if ('kind' in p) return p;
    const name = key as Uint8Array;
    const doc = await readJson(ks, name);
    if (!isDoc(doc)) return doc ?? integer(0);
    if (p.segments.length === 0) {
      ks.delete(name, doc.header);
      return integer(1);
    }
    if (!deleteAt(doc.root, p.segments)) return integer(0);
    doc.header.value = jsonBytes(doc.root);
    ks.write(name, doc.header);
    return integer(1);
  },
};

const MGET: KvCommand = {
  name: 'JSON.MGET',
  arity: -3,
  flags: ['readonly'],
  keys: { first: 1, last: -2, step: 1 },
  async execute(ks, args) {
    const rawPath = args.at(-1);
    const p = path(rawPath);
    if ('kind' in p) return p;
    const out: KvReply[] = [];
    for (const key of args.slice(0, -1)) {
      const doc = await readJson(ks, key);
      if (!isDoc(doc)) {
        out.push(nil());
        continue;
      }
      const result = select(doc.root, p);
      out.push(result === undefined ? nil() : bulk(jsonBytes(result)));
    }
    return array(out);
  },
};

export const jsonCommands: KvCommand[] = [SET, GET, DEL, MGET];
