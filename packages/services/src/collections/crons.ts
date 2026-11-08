import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { nextFire, parseCron } from '@mindlog/collections';
import type { CollectionInput } from '@mindlog/collections';
import type { JobSpec } from '@mindlog/proto';
import { JobSpecSchema } from '@mindlog/proto';
import { CRON_JOB } from './collection-jobs.js';
import type { CollectionService } from './collection-service.js';
import type { RecordHooks } from './record-hooks.js';
import type { RequestContext } from './record-reader.js';

export const CRON_COLLECTION = '_cron';
const SCHEMA: CollectionInput = {
  name: CRON_COLLECTION,
  fields: [
    { name: 'name', type: 'text' },
    { name: 'expr', type: 'text' },
    { name: 'lastMs', type: 'number' },
  ],
};

const encoder = new TextEncoder();
export const cronRecordId = (name: string): string =>
  createHash('sha256').update(name).digest('hex').slice(0, 15);
const system = (tenant: string): RequestContext => ({
  identity: { kind: 'superuser', email: 'system:cron' },
  tenant,
});

/** The job of the fire at `nextFire(expr, afterMs)`; `undefined` when it never fires. */
export function cronJob(name: string, expr: string, afterMs: number): JobSpec | undefined {
  const cron = parseCron(expr);
  const at = cron && nextFire(cron, afterMs);
  if (at === undefined) return undefined;
  return create(JobSpecSchema, {
    id: `cron-${name}-${String(at)}`,
    kind: CRON_JOB,
    payload: encoder.encode(name),
    runAtMs: BigInt(at),
  });
}

/**
 * Starts the job chain of each cron not seen before (PLAN 16.8). The record's
 * id comes from the name, so a restart or a second node starts no second chain.
 *
 * shortcut: a chain whose job went dead stays stopped until its `_cron` record is deleted; add a sweep if that happens.
 */
export async function ensureCrons(
  collections: CollectionService,
  hooks: RecordHooks,
  tenant: string,
  clock: Clock,
): Promise<Result<void, MindlogError>> {
  if (hooks.crons().length === 0) return ok(undefined);
  const ctx = system(tenant);
  const made = await collections.saveCollection(ctx, SCHEMA);
  if (!made.ok && made.error.code !== 'ALREADY_EXISTS' && made.error.code !== 'CONFLICT')
    return made;
  for (const { name, expr } of hooks.crons()) {
    const job = cronJob(name, expr, Number(clock.now()));
    if (!job) return err(mindlogError('CONFIG_INVALID', `cron ${name} never fires: ${expr}`));
    const started = await collections.create(
      ctx,
      CRON_COLLECTION,
      { id: cronRecordId(name), name, expr, lastMs: 0 },
      { enqueue: [job] },
    );
    if (!started.ok && started.error.code !== 'ALREADY_EXISTS') return started;
  }
  return ok(undefined);
}
