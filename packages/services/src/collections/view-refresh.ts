import { create, toBinary } from '@bufbuild/protobuf';
import { randomBytes } from 'node:crypto';
import type { MindlogError, Result } from '@mindlog/core';
import { ok } from '@mindlog/core';
import { MAX_RECORD_OPS, computeView, viewSources } from '@mindlog/collections';
import type { CollectionSchema } from '@mindlog/collections';
import type { RecordOp } from '@mindlog/proto';
import { RecordOpKind, RecordOpSchema, RecordWriteSchema } from '@mindlog/proto';
import type { RecordData } from '@mindlog/rules';
import type { CollectionRanges, ProposeOutcome } from './collection-ranges.js';
import type { RecordReader } from './record-reader.js';
import { ruleRecord } from './record-reader.js';

const encoder = new TextEncoder();

/**
 * Brings a view's rows up to date (PLAN 16.7): only rows that differ are
 * written, so subscribers see only real changes.
 *
 * shortcut: re-reads every source record (up to MAX_SCAN) on each refresh, because
 * an update's command does not carry the old group key; add per-group
 * recomputation when views over large collections get slow.
 */
export async function refreshView(
  reader: RecordReader,
  ranges: CollectionRanges,
  view: CollectionSchema,
): Promise<Result<void, MindlogError>> {
  if (!view.view) return ok(undefined);
  const sources = new Map<string, RecordData[]>();
  for (const name of viewSources(view.view)) {
    const rows = await reader.matching(name, undefined);
    if (!rows.ok) return rows;
    sources.set(
      name,
      rows.value.map((r) => ruleRecord(name, r)),
    );
  }
  const wanted = computeView(view.view, sources);
  const current = await reader.matching(view.name, undefined);
  if (!current.ok) return current;
  const ops: RecordOp[] = [];
  const have = new Map(current.value.map((r) => [r.id, r.data]));
  for (const [id, fields] of wanted) {
    const before = have.get(id);
    const same =
      before &&
      Object.entries(fields).every(([k, v]) => JSON.stringify(before[k]) === JSON.stringify(v));
    if (!same)
      ops.push(
        create(RecordOpSchema, {
          kind: RecordOpKind.UPSERT,
          id,
          data: encoder.encode(JSON.stringify(fields)),
        }),
      );
  }
  for (const id of have.keys()) {
    if (!wanted.has(id)) ops.push(create(RecordOpSchema, { kind: RecordOpKind.DELETE, id }));
  }
  for (let i = 0; i < ops.length; i += MAX_RECORD_OPS) {
    const write = create(RecordWriteSchema, {
      collection: view.name,
      ops: ops.slice(i, i + MAX_RECORD_OPS),
    });
    const done = await ranges.run<ProposeOutcome>(
      reader.caller,
      view.name,
      {
        op: 'propose',
        body: 'recordWrite',
        bytes: Buffer.from(toBinary(RecordWriteSchema, write)).toString('base64'),
        actor: '',
      },
      randomBytes(16),
    );
    if (!done.ok) return done;
  }
  return ok(undefined);
}
