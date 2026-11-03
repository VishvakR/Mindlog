import { create, toBinary } from '@bufbuild/protobuf';
import { decodeKey } from '@mindlog/core';
import { StoredSchemaSchema } from '@mindlog/proto';
import type { CommandResult } from '@mindlog/proto';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { fieldValidate, fieldZero } from '../fields/registry.js';
import { recordKey, recordPrefix, schemaKey } from '../keys.js';
import { indexEntries } from '../record-data.js';
import type { RecordFields } from '../record-data.js';
import type { CollectionSchema } from '../schema/collection-schema.js';
import { parseSchema } from '../schema/collection-schema.js';
import { checkSchema, indexesOf, storedFields } from '../schema/system-fields.js';
import {
  decodeRecord,
  dropRows,
  recordMeta,
  storedRecord,
  takenClaim,
  writeRecord,
} from './record-rows.js';
import type { DecodedRecord } from './record-rows.js';
import { fieldErrors, loadSchema, outsideRange, recordOutcome } from './results.js';
import { Staged } from './staged.js';

/**
 * Collections up to this many records can change indexes or fields, or be
 * deleted, in one command. shortcut: larger ones are refused; rewrite them
 * in batches through jobs when a collection outgrows it.
 */
export const MAX_REWRITE_RECORDS = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * `SchemaChange` (ADR-0034): creates, replaces or deletes a collection schema,
 * fenced by `expect_version`. Index or field changes rewrite every record's
 * rows; a unique index the existing records violate refuses the change.
 */
export const schemaChangeHandler: ApplyHandler = {
  body: 'schemaChange',
  async apply(ctx) {
    if (ctx.command.body.case !== 'schemaChange') throw new Error('schemaChange got another body');
    const change = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, change.collection);
    if (moved) return moved;
    const current = await loadSchema((k) => ctx.txn.get(k), tenant, change.collection);
    if ((current?.version ?? 0n) !== change.expectVersion) {
      return errorResult(
        current ? 'CONFLICT' : 'NOT_FOUND',
        current
          ? `collection ${change.collection} changed since it was read`
          : `no collection ${change.collection}`,
      );
    }
    const staged = new Staged(ctx.txn);
    let next: CollectionSchema | undefined;
    if (change.schema.length > 0) {
      const parsed = parseJson(change.schema);
      if (parsed instanceof Error) return errorResult('INVALID_ARGUMENT', 'schema is not JSON');
      const valid = parseSchema(parsed);
      const checked = valid.ok ? checkSchema(valid.value) : valid;
      if (!checked.ok)
        return fieldErrors('INVALID_ARGUMENT', checked.error.message, checked.error.fields ?? {});
      next = checked.value;
      if (next.name !== change.collection)
        return errorResult('INVALID_ARGUMENT', 'the schema names another collection');
      if (current && current.schema.type !== next.type) {
        return errorResult('INVALID_ARGUMENT', 'a collection keeps its type');
      }
    }
    if (current && (next === undefined || needsRewrite(current.schema, next))) {
      const failed = await rewrite(ctx, staged, change.collection, current.schema, next);
      if (failed) return failed;
    }
    if (next === undefined) staged.delete(schemaKey(tenant, change.collection));
    else {
      const schema = encoder.encode(JSON.stringify(next));
      staged.put(
        schemaKey(tenant, change.collection),
        toBinary(StoredSchemaSchema, create(StoredSchemaSchema, { schema, version: ctx.version })),
      );
    }
    staged.flush();
    return recordOutcome([change.collection], [next === undefined ? 0n : ctx.version]);
  },
};

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (e) {
    return e instanceof Error ? e : new Error('invalid JSON');
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function needsRewrite(before: CollectionSchema, after: CollectionSchema): boolean {
  return (
    !same(indexesOf(before), indexesOf(after)) || !same(storedFields(before), storedFields(after))
  );
}

/** Rewrites every record for the new schema (or deletes them all when `next` is undefined). */
async function rewrite(
  ctx: ApplyContext,
  staged: Staged,
  collection: string,
  before: CollectionSchema,
  next: CollectionSchema | undefined,
): Promise<CommandResult | undefined> {
  const { tenant } = ctx.command;
  const records: [string, DecodedRecord][] = [];
  for await (const { key, value } of staged.scan(recordPrefix(tenant, collection))) {
    if (records.length >= MAX_REWRITE_RECORDS) {
      return errorResult(
        'INVALID_ARGUMENT',
        `collections over ${String(MAX_REWRITE_RECORDS)} records cannot change this way`,
      );
    }
    const decoded = decodeKey(key);
    const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
    if (typeof id === 'string') records.push([id, decodeRecord(value)]);
  }
  for (const [id, record] of records) {
    dropRows(staged, tenant, collection, before, id, record);
    if (next === undefined) staged.delete(recordKey(tenant, collection, id));
  }
  if (next === undefined) return undefined;
  for (const [id, record] of records) {
    const data = migrate(next, record.data);
    const stored = storedRecord(
      data,
      record.stored.createdMs,
      record.stored.updatedMs,
      record.stored.version,
    );
    const entries = indexEntries(next, data, recordMeta(id, stored));
    const taken = await takenClaim(staged, tenant, collection, id, entries);
    if (taken) {
      return fieldErrors('ALREADY_EXISTS', `existing records break unique index ${taken.index}`, {
        [`indexes.${taken.index}`]: 'existing records are not unique',
      });
    }
    writeRecord(staged, tenant, collection, id, stored, entries);
  }
  return undefined;
}

/** Keeps the values still valid under the new fields; others become zero values. */
function migrate(schema: CollectionSchema, data: RecordFields): RecordFields {
  const out: RecordFields = {};
  for (const f of storedFields(schema)) {
    const value = Object.hasOwn(data, f.name) ? data[f.name] : undefined;
    out[f.name] =
      value !== undefined && fieldValidate(f, value) === undefined ? value : fieldZero(f);
  }
  return out;
}
