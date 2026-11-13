import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { sizeDelimitedDecodeStream, sizeDelimitedEncode } from '@bufbuild/protobuf/wire';
import type { BlobStore } from '@mindlog/blob';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { KeyValue, SnapshotMeta } from '@mindlog/proto';
import { MessageSchema, SnapshotRequestSchema } from '@mindlog/proto';
import type { StateSnapshot } from '@mindlog/statemachine';

/** Backups live under `backups/<id>/` in the default blob store (ADR-0041). */
export const BACKUP_ROOT = 'backups';

/** What `<rangeId>.json` records about `<rangeId>.snap`; written after it, so it marks it complete. */
export interface RangeManifest {
  readonly rangeId: string;
  readonly index: string;
  readonly term: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly nodeId: string;
  readonly atMs: number;
}

export interface RangeBackup {
  readonly meta: SnapshotMeta;
  readonly pairs: readonly KeyValue[];
}

/** `20261113T120000Z`: sorts in time order, so nodes on one schedule share a folder. */
export const backupId = (atMs: number): string =>
  new Date(atMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

export const snapKey = (id: string, rangeId: bigint): string =>
  `${BACKUP_ROOT}/${id}/${rangeId.toString()}.snap`;
export const manifestKey = (id: string, rangeId: bigint): string =>
  `${BACKUP_ROOT}/${id}/${rangeId.toString()}.json`;

export const sha256 = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * A range snapshot as size-delimited `SnapshotRequest`s, the framing of the
 * snapshot stream: the first carries the metadata, each carries one chunk.
 */
export async function encodeSnapshot(
  snapshot: StateSnapshot,
  rangeId: bigint,
  chunkBytes: number,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const record = (pairs: KeyValue[]) => {
    const message =
      parts.length === 0 ? create(MessageSchema, { rangeId, snapshot: snapshot.meta }) : undefined;
    parts.push(
      sizeDelimitedEncode(
        SnapshotRequestSchema,
        create(SnapshotRequestSchema, { ...(message ? { message } : {}), pairs }),
      ),
    );
  };
  for await (const chunk of snapshot.chunks(chunkBytes)) record(chunk);
  if (parts.length === 0) record([]);
  return Buffer.concat(parts);
}

export async function decodeSnapshot(
  bytes: Uint8Array,
): Promise<Result<RangeBackup & { rangeId: bigint }, MindlogError>> {
  let meta: SnapshotMeta | undefined;
  let rangeId = 0n;
  const pairs: KeyValue[] = [];
  try {
    for await (const req of sizeDelimitedDecodeStream(SnapshotRequestSchema, single(bytes))) {
      if (!meta && req.message?.snapshot) {
        meta = req.message.snapshot;
        rangeId = req.message.rangeId;
      }
      pairs.push(...req.pairs);
    }
  } catch (cause: unknown) {
    return err(mindlogError('INTERNAL', 'the backup does not decode', { cause }));
  }
  return meta
    ? ok({ meta, rangeId, pairs })
    : err(mindlogError('INTERNAL', 'the backup has no snapshot metadata'));
}

async function* single(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  yield bytes;
}

/** Backup ids in the store, oldest first. */
export async function listBackups(blob: BlobStore): Promise<Result<string[], MindlogError>> {
  const keys = await blob.list(BACKUP_ROOT);
  if (!keys.ok) return keys;
  const ids = new Set(keys.value.map((k) => k.split('/')[1]).filter((id) => id !== undefined));
  return ok([...ids].sort());
}

/** Every complete range of a backup, each checked against its manifest. */
export async function loadBackup(
  blob: BlobStore,
  id: string,
): Promise<Result<Map<bigint, RangeBackup>, MindlogError>> {
  const keys = await blob.list(`${BACKUP_ROOT}/${id}`);
  if (!keys.ok) return keys;
  const ranges = new Map<bigint, RangeBackup>();
  for (const key of keys.value.filter((k) => k.endsWith('.json'))) {
    const raw = await blob.get(key);
    if (!raw.ok) return raw;
    if (!raw.value) continue;
    const manifest = JSON.parse(Buffer.from(raw.value).toString('utf8')) as RangeManifest;
    const rangeId = BigInt(manifest.rangeId);
    const snap = await blob.get(snapKey(id, rangeId));
    if (!snap.ok) return snap;
    const bad = (why: string) =>
      err(mindlogError('INTERNAL', `backup ${id} range ${manifest.rangeId}: ${why}`));
    if (!snap.value) return bad('the snapshot is missing');
    if (snap.value.length !== manifest.bytes || sha256(snap.value) !== manifest.sha256)
      return bad('the snapshot does not match its manifest');
    const decoded = await decodeSnapshot(snap.value);
    if (!decoded.ok) return decoded;
    if (decoded.value.rangeId !== rangeId || decoded.value.meta.index.toString() !== manifest.index)
      return bad('the snapshot is of another range or index');
    ranges.set(rangeId, { meta: decoded.value.meta, pairs: decoded.value.pairs });
  }
  if (ranges.size === 0)
    return err(mindlogError('NOT_FOUND', `no complete ranges in backup ${id}`));
  return ok(ranges);
}
