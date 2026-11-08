import { create } from '@bufbuild/protobuf';
import type { Expr } from '@mindlog/rules';
import type { JobSpec } from '@mindlog/proto';
import { JobSpecSchema } from '@mindlog/proto';
import type { CollectionSchema, FieldDef } from '@mindlog/collections';
import { storedFields } from '@mindlog/collections';
import type { StoredCollection } from './collection-ranges.js';

export const FILES_JOB = 'collections.files';
export const CASCADE_JOB = 'collections.cascade';
export const VIEW_JOB = 'collections.view';
export const HOOK_JOB = 'collections.hook';
export const CRON_JOB = 'collections.cron';

/** Orphan files younger than this may belong to an upload that has not been proposed yet. */
export const FILE_GRACE_MS = 10 * 60_000;
const BUCKET_MS = 10 * 60_000;

const encoder = new TextEncoder();

/** One janitor run per collection per bucket: the id and time depend only on the bucket. */
export function fileJanitorJob(nowMs: number): JobSpec {
  const bucket = Math.floor(nowMs / BUCKET_MS);
  return create(JobSpecSchema, {
    id: `files-${String(bucket)}`,
    kind: FILES_JOB,
    runAtMs: BigInt((bucket + 1) * BUCKET_MS + FILE_GRACE_MS),
  });
}

/** Refreshes the views reading a collection; one per second and collection, after the write. */
export function viewRefreshJob(nowMs: number): JobSpec {
  const second = Math.floor(nowMs / 1000);
  return create(JobSpecSchema, {
    id: `view-${String(second)}`,
    kind: VIEW_JOB,
    runAtMs: BigInt((second + 1) * 1000),
  });
}

export function cascadeJob(id: string): JobSpec {
  return create(JobSpecSchema, {
    id: `cascade-${id}`,
    kind: CASCADE_JOB,
    payload: encoder.encode(id),
  });
}

/** Relation fields, across the tenant, that point at `collection`. */
export function referencesTo(
  catalog: ReadonlyMap<string, StoredCollection>,
  collection: string,
): { schema: CollectionSchema; field: Extract<FieldDef, { type: 'relation' }> }[] {
  return [...catalog.values()].flatMap(({ schema }) =>
    storedFields(schema).flatMap((field) =>
      field.type === 'relation' && field.collection === collection ? [{ schema, field }] : [],
    ),
  );
}

/** Records whose relation `field` holds `id`. */
export function holds(field: string, id: string): Expr {
  const span = { from: 0, to: 0 };
  return {
    kind: 'compare',
    op: '?=',
    left: { kind: 'ident', root: { kind: 'record' }, path: [field], ...span },
    right: { kind: 'literal', value: id, ...span },
    ...span,
  };
}
