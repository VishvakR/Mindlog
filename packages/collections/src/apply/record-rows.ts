import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { StoredRecord } from '@mindlog/proto';
import { StoredRecordSchema } from '@mindlog/proto';
import { indexRowKey, recordKey, uniqueKey } from '../keys.js';
import type { IndexEntry, RecordFields } from '../record-data.js';
import { claims, indexEntries } from '../record-data.js';
import type { CollectionSchema } from '../schema/collection-schema.js';
import type { Staged } from './staged.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface DecodedRecord {
  readonly stored: StoredRecord;
  readonly data: RecordFields;
}

export function decodeRecord(bytes: Uint8Array): DecodedRecord {
  const stored = fromBinary(StoredRecordSchema, bytes);
  return { stored, data: JSON.parse(decoder.decode(stored.data)) as RecordFields };
}

const metaOf = (id: string, stored: StoredRecord) => ({
  id,
  createdMs: stored.createdMs,
  updatedMs: stored.updatedMs,
});

/** The unique index whose claim another record holds, if any. */
export async function takenClaim(
  staged: Staged,
  tenant: string,
  collection: string,
  id: string,
  entries: readonly IndexEntry[],
): Promise<IndexEntry | undefined> {
  for (const e of entries) {
    if (!claims(e)) continue;
    const holder = await staged.get(uniqueKey(tenant, collection, e.index, e.values));
    if (holder !== undefined && decoder.decode(holder) !== id) return e;
  }
  return undefined;
}

/** Removes a record's index rows and the unique claims it holds. */
export function dropRows(
  staged: Staged,
  tenant: string,
  collection: string,
  schema: CollectionSchema,
  id: string,
  record: DecodedRecord,
): void {
  for (const e of indexEntries(schema, record.data, metaOf(id, record.stored))) {
    staged.delete(indexRowKey(tenant, collection, e.index, e.values, id));
    if (claims(e)) staged.delete(uniqueKey(tenant, collection, e.index, e.values));
  }
}

/** Writes a record with its index rows and unique claims. */
export function writeRecord(
  staged: Staged,
  tenant: string,
  collection: string,
  id: string,
  stored: StoredRecord,
  entries: readonly IndexEntry[],
): void {
  for (const e of entries) {
    staged.put(indexRowKey(tenant, collection, e.index, e.values, id), new Uint8Array());
    if (claims(e)) staged.put(uniqueKey(tenant, collection, e.index, e.values), encoder.encode(id));
  }
  staged.put(recordKey(tenant, collection, id), toBinary(StoredRecordSchema, stored));
}

export function storedRecord(
  data: RecordFields,
  createdMs: bigint,
  updatedMs: bigint,
  version: bigint,
): StoredRecord {
  return create(StoredRecordSchema, {
    data: encoder.encode(JSON.stringify(data)),
    createdMs,
    updatedMs,
    version,
  });
}

export const recordMeta = metaOf;
