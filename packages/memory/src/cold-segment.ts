import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { MemoryRecord } from '@mindlog/proto';
import { MemoryRecordSchema } from '@mindlog/proto';

// Cold tier segments (PLAN 10.4, ADR-0033): the full records of memories moved
// cold together, with their vectors, as gzip JSON in the blob store.

export interface ColdEntry {
  readonly record: MemoryRecord;
  /** float32 little-endian; empty when it had none. */
  readonly vector: Uint8Array;
  readonly modelId: string;
}

interface Stored {
  readonly v: 1;
  readonly entries: ReadonlyArray<{ record: string; vector: string; modelId: string }>;
}

export interface EncodedSegment {
  readonly key: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

/** A segment and its content-addressed key `cold/<tenant>/<user>/<sha256>.json.gz`. */
export function encodeSegment(
  tenant: string,
  user: string,
  entries: readonly ColdEntry[],
): EncodedSegment {
  const stored: Stored = {
    v: 1,
    entries: entries.map((e) => ({
      record: b64(toBinary(MemoryRecordSchema, e.record)),
      vector: b64(e.vector),
      modelId: e.modelId,
    })),
  };
  // Level and mtime are fixed by gzip's defaults, so equal entries give equal bytes.
  const bytes = new Uint8Array(gzipSync(JSON.stringify(stored)));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { key: segmentKey(tenant, user, sha256), sha256, bytes };
}

/** Blob keys allow `[A-Za-z0-9._-]` segments; other characters of a tenant or user are hex-escaped. */
const safe = (s: string) =>
  s === '' ? '_' : s.replace(/[^A-Za-z0-9._-]/g, (c) => `~${c.charCodeAt(0).toString(16)}`);

export const segmentKey = (tenant: string, user: string, sha256: string): string =>
  `cold/${safe(tenant)}/${safe(user)}/${sha256}.json.gz`;

/** The entries of a segment, after checking its sha256; undefined when it does not match. */
export function decodeSegment(bytes: Uint8Array, sha256: string): ColdEntry[] | undefined {
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) return undefined;
  const stored = JSON.parse(gunzipSync(bytes).toString('utf8')) as Stored;
  return stored.entries.map((e) => ({
    record: fromBinary(MemoryRecordSchema, unb64(e.record)),
    vector: unb64(e.vector),
    modelId: e.modelId,
  }));
}

const FIRST_SENTENCE = /^[^.!?\n]*[.!?]?/;
/** Longest stub text a cold record keeps. */
export const STUB_CHARS = 160;

/** The stub a cold record keeps in place of its text: its first sentence, at most 160 chars. */
export function stubText(text: string): string {
  const first = (text.match(FIRST_SENTENCE)?.[0] ?? '').trim() || text.trim();
  return first.length > STUB_CHARS ? `${first.slice(0, STUB_CHARS - 1)}…` : first;
}
