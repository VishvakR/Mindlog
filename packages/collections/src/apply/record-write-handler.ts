import type { CommandResult, RecordOp } from '@mindlog/proto';
import { RecordOpKind } from '@mindlog/proto';
import { collectionScope, completeJob, enqueueJob } from '@mindlog/jobs';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { RECORD_ID } from '../fields/list-fields.js';
import { recordKey } from '../keys.js';
import { completeRecord, indexEntries } from '../record-data.js';
import type { RecordFields } from '../record-data.js';
import type { CollectionSchema } from '../schema/collection-schema.js';
import {
  decodeRecord,
  dropRows,
  recordMeta,
  storedRecord,
  takenClaim,
  writeRecord,
} from './record-rows.js';
import { fieldErrors, loadSchema, outsideRange, recordOutcome } from './results.js';
import { Staged } from './staged.js';

/** Ops per `RecordWrite`. */
export const MAX_RECORD_OPS = 100;

const decoder = new TextDecoder();

/**
 * `RecordWrite` (ADR-0034): validates every op against the stored schema, the
 * expected versions and the unique claims, and only then writes the records,
 * their index rows and claims, the finished job and the new jobs.
 */
export const recordWriteHandler: ApplyHandler = {
  body: 'recordWrite',
  async apply(ctx) {
    if (ctx.command.body.case !== 'recordWrite') throw new Error('recordWrite got another body');
    const write = ctx.command.body.value;
    const moved = outsideRange(ctx, write.collection);
    if (moved) return moved;
    if (write.ops.length === 0 || write.ops.length > MAX_RECORD_OPS) {
      return errorResult('INVALID_ARGUMENT', `a write has 1 to ${String(MAX_RECORD_OPS)} ops`);
    }
    if (new Set(write.ops.map((o) => o.id)).size !== write.ops.length) {
      return errorResult('INVALID_ARGUMENT', 'a write names each record once');
    }
    const loaded = await loadSchema((k) => ctx.txn.get(k), ctx.command.tenant, write.collection);
    if (!loaded) return errorResult('NOT_FOUND', `no collection ${write.collection}`);
    const staged = new Staged(ctx.txn);
    const ids: string[] = [];
    const versions: bigint[] = [];
    for (const op of write.ops) {
      const failed = await applyOp(ctx, staged, loaded.schema, write.collection, op);
      if (failed) return failed;
      ids.push(op.id);
      versions.push(op.kind === RecordOpKind.DELETE ? 0n : ctx.version);
    }
    const scope = collectionScope(write.collection);
    if (write.complete) {
      const completed = await completeJob(ctx, scope, write.complete);
      if (completed.outcome.case === 'error') return completed;
    }
    staged.flush();
    for (const spec of write.enqueue) {
      const failed = enqueueJob(ctx, scope, spec);
      if (failed) return failed;
    }
    return recordOutcome(ids, versions);
  },
};

async function applyOp(
  ctx: ApplyContext,
  staged: Staged,
  schema: CollectionSchema,
  collection: string,
  op: RecordOp,
): Promise<CommandResult | undefined> {
  const { tenant } = ctx.command;
  if (!RECORD_ID.test(op.id)) return errorResult('INVALID_ARGUMENT', `invalid record id ${op.id}`);
  const isView = schema.type === 'view';
  if (op.kind === RecordOpKind.UPSERT ? !isView : isView && op.kind !== RecordOpKind.DELETE) {
    return errorResult(
      'INVALID_ARGUMENT',
      isView ? 'view records are maintained by Mindlog' : 'upsert is for views',
    );
  }
  const bytes = await staged.get(recordKey(tenant, collection, op.id));
  const existing = bytes === undefined ? undefined : decodeRecord(bytes);
  switch (op.kind) {
    case RecordOpKind.CREATE:
      if (existing) return errorResult('ALREADY_EXISTS', `record ${op.id} exists`);
      break;
    case RecordOpKind.UPDATE:
    case RecordOpKind.DELETE:
      if (!existing) return errorResult('NOT_FOUND', `no record ${op.id}`);
      if (
        (op.kind === RecordOpKind.UPDATE || op.expectVersion !== 0n) &&
        existing.stored.version !== op.expectVersion
      ) {
        return errorResult('CONFLICT', `record ${op.id} changed since it was read`);
      }
      break;
    case RecordOpKind.UPSERT:
      break;
    default:
      return errorResult('INVALID_ARGUMENT', 'unknown record op');
  }
  if (existing) dropRows(staged, tenant, collection, schema, op.id, existing);
  if (op.kind === RecordOpKind.DELETE) {
    staged.delete(recordKey(tenant, collection, op.id));
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoder.decode(op.data));
  } catch {
    return errorResult('INVALID_ARGUMENT', 'record data is not JSON');
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return errorResult('INVALID_ARGUMENT', 'record data is not an object');
  }
  const complete = completeRecord(schema, raw as RecordFields);
  if (!complete.ok) return fieldErrors('INVALID_ARGUMENT', 'invalid record', complete.fields);
  const createdMs = existing?.stored.createdMs ?? ctx.nowMs;
  const stored = storedRecord(complete.value, createdMs, ctx.nowMs, ctx.version);
  const entries = indexEntries(schema, complete.value, recordMeta(op.id, stored));
  const taken = await takenClaim(staged, tenant, collection, op.id, entries);
  if (taken) {
    const index = schema.indexes.find((i) => i.name === taken.index);
    const fields = Object.fromEntries(
      (index?.fields ?? ['email']).map((f) => [f, 'must be unique']),
    );
    return fieldErrors(
      'ALREADY_EXISTS',
      `unique index ${taken.index} already has this value`,
      fields,
    );
  }
  writeRecord(staged, tenant, collection, op.id, stored, entries);
  return undefined;
}
