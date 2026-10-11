import type { MindlogError } from '../errors/mindlog-error.js';
import { mindlogError } from '../errors/mindlog-error.js';
import type { Result } from '../result/result.js';
import { err, ok } from '../result/result.js';
import { ByteWriter } from './byte-writer.js';
import { decodeTuple } from './decode-tuple.js';
import type { Tuple, TupleElement } from './tuple.js';
import { appendTuple } from './tuple.js';
import { TupleCode } from './tuple-codes.js';
import { appendVersion } from './version.js';

/** Key families of the shared keyspace (PLAN 5.1). */
export const KeyFamily = {
  KV: 'k',
  MEMORY: 'm',
  VECTOR: 'v',
  TERM: 't',
  GRAPH: 'g',
  ENTITY: 'e',
  COLLECTION: 'c',
  INDEX: 'x',
  UNIQUE: 'u',
  CACHE: 'q',
  JOB: 'j',
  SYSTEM: 's',
} as const;

export type KeyFamily = (typeof KeyFamily)[keyof typeof KeyFamily];

const FAMILIES = new Set<string>(Object.values(KeyFamily));

export interface KeyParts {
  /** Resolved tenant; every key carries one (CLAUDE.md rule 10). */
  readonly tenant: string;
  readonly family: KeyFamily;
  readonly tuple: Tuple;
  /** MVCC commit index; omitted for unversioned keys. */
  readonly version?: bigint;
}

/** Half-open byte range [start, end). */
export interface KeyRange {
  readonly start: Uint8Array;
  readonly end: Uint8Array;
}

/**
 * Encodes `tenant · family · tuple [· '@' version]` as self-delimiting tuple
 * elements, so byte order is tenant, then family, then tuple order, then
 * newest version first.
 */
export function encodeKey(parts: KeyParts): Result<Uint8Array, MindlogError> {
  const writer = new ByteWriter();
  const head = appendHead(writer, parts.tenant, parts.family, parts.tuple);
  if (!head.ok) return head;
  if (parts.version !== undefined) {
    const version = appendVersion(writer, parts.version);
    if (!version.ok) return version;
  }
  return ok(writer.finish());
}

/** Encoded prefix shared by every key under `tenant`, `family` and a tuple prefix. */
export function keyPrefix(
  tenant: string,
  family?: KeyFamily,
  tuple: Tuple = [],
): Result<Uint8Array, MindlogError> {
  const writer = new ByteWriter();
  const head = appendHead(writer, tenant, family, tuple);
  return head.ok ? ok(writer.finish()) : head;
}

/** Range covering the prefix itself and every key that extends it. */
export function prefixRange(prefix: Uint8Array): KeyRange {
  const end = new Uint8Array(prefix.length + 1);
  end.set(prefix);
  end[prefix.length] = 0xff;
  return { start: prefix, end };
}

/** Range covering every version of one unversioned key. */
export function versionsRange(unversionedKey: Uint8Array): KeyRange {
  const at = (marker: number) => {
    const out = new Uint8Array(unversionedKey.length + 1);
    out.set(unversionedKey);
    out[unversionedKey.length] = marker;
    return out;
  };
  return { start: at(TupleCode.VERSION), end: at(TupleCode.VERSION + 1) };
}

export function decodeKey(bytes: Uint8Array): Result<KeyParts, MindlogError> {
  const decoded = decodeTuple(bytes);
  if (!decoded.ok) return decoded;
  const [tenant, family, ...tuple] = decoded.value.elements;
  if (typeof tenant !== 'string' || tenant === '') {
    return err(mindlogError('KEY_DECODE_FAILED', 'key does not start with a tenant'));
  }
  if (!isKeyFamily(family)) {
    return err(mindlogError('KEY_DECODE_FAILED', 'key has no valid family'));
  }
  const { version } = decoded.value;
  return ok(version === undefined ? { tenant, family, tuple } : { tenant, family, tuple, version });
}

function isKeyFamily(value: TupleElement | undefined): value is KeyFamily {
  return typeof value === 'string' && FAMILIES.has(value);
}

function appendHead(
  writer: ByteWriter,
  tenant: string,
  family: KeyFamily | undefined,
  tuple: Tuple,
): Result<void, MindlogError> {
  if (tenant === '') return err(mindlogError('INVALID_ARGUMENT', 'tenant must not be empty'));
  if (family === undefined) {
    if (tuple.length > 0) {
      return err(mindlogError('INVALID_ARGUMENT', 'a tuple prefix needs a key family'));
    }
    return appendTuple(writer, [tenant]);
  }
  if (!FAMILIES.has(family)) {
    return err(mindlogError('INVALID_ARGUMENT', `unknown key family "${family}"`));
  }
  return appendTuple(writer, [tenant, family, ...tuple]);
}
