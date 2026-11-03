import type { TupleElement } from '@mindlog/core';
import { formatDate } from '@mindlog/rules';
import { fieldValidate, fieldZero } from './fields/registry.js';
import type { CollectionSchema } from './schema/collection-schema.js';
import { indexesOf, storedFields } from './schema/system-fields.js';

/** A record's own fields as stored (JSON), without `id`, `created` and `updated`. */
export type RecordFields = Record<string, unknown>;

/**
 * Fills missing fields with their zero values and checks every field.
 * Deterministic: apply runs it. Returns the complete record, or per-field messages.
 */
export function completeRecord(
  schema: CollectionSchema,
  data: RecordFields,
): { ok: true; value: RecordFields } | { ok: false; fields: Record<string, string> } {
  const fields = storedFields(schema);
  const problems: Record<string, string> = {};
  for (const key of Object.keys(data)) {
    if (!fields.some((f) => f.name === key)) problems[key] = 'unknown field';
  }
  const out: RecordFields = {};
  for (const f of fields) {
    const value = Object.hasOwn(data, f.name) ? data[f.name] : fieldZero(f);
    const problem = fieldValidate(f, value);
    if (problem !== undefined) problems[f.name] = problem;
    out[f.name] = value;
  }
  return Object.keys(problems).length > 0
    ? { ok: false, fields: problems }
    : { ok: true, value: out };
}

/** System-field values an index can name. */
export interface RecordMeta {
  readonly id: string;
  readonly createdMs: bigint;
  readonly updatedMs: bigint;
}

function indexValue(name: string, data: RecordFields, meta: RecordMeta): TupleElement {
  if (name === 'id') return meta.id;
  if (name === 'created') return formatDate(Number(meta.createdMs));
  if (name === 'updated') return formatDate(Number(meta.updatedMs));
  const v = data[name];
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
}

export interface IndexEntry {
  readonly index: string;
  readonly unique: boolean;
  readonly values: readonly TupleElement[];
}

/** The index rows of a record; unique claims skip empty values (a partial index, like PocketBase's email). */
export function indexEntries(
  schema: CollectionSchema,
  data: RecordFields,
  meta: RecordMeta,
): IndexEntry[] {
  return indexesOf(schema).map((index) => ({
    index: index.name,
    unique: index.unique,
    values: index.fields.map((f) => indexValue(f, data, meta)),
  }));
}

export const claims = (entry: IndexEntry): boolean =>
  entry.unique && entry.values.every((v) => v !== null && v !== '');
