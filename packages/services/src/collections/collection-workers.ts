import type { Clock, Logger } from '@mindlog/core';
import { ok } from '@mindlog/core';
import { COLLECTION_SCOPE } from '@mindlog/jobs';
import type { Worker } from '@mindlog/jobs';
import { viewSources } from '@mindlog/collections';
import {
  CASCADE_JOB,
  CRON_JOB,
  FILES_JOB,
  HOOK_JOB,
  VIEW_JOB,
  holds,
  referencesTo,
} from './collection-jobs.js';
import { CRON_COLLECTION, cronJob, cronRecordId } from './crons.js';
import type { HookCall, RecordHooks } from './record-hooks.js';
import type { CollectionService } from './collection-service.js';
import type { RecordFiles } from './record-files.js';
import type { RequestContext } from './record-reader.js';

const decoder = new TextDecoder();

/** Durable work of collections (ADR-0034); each worker is idempotent. */
export function collectionWorkers(d: {
  readonly collections: CollectionService;
  readonly files?: RecordFiles;
  readonly hooks?: RecordHooks;
  readonly clock?: Clock;
  readonly logger?: Logger;
}): Worker[] {
  const system = (tenant: string): RequestContext => ({
    identity: { kind: 'superuser', email: 'system:jobs' },
    tenant,
  });
  const cascade: Worker = {
    kind: CASCADE_JOB,
    async run({ tenant, user, job }) {
      const ctx = system(tenant);
      const id = decoder.decode(job.payload);
      const reader = await d.collections.reader(ctx);
      if (!reader.ok) return reader;
      const target = user.slice(COLLECTION_SCOPE.length);
      for (const { schema, field } of referencesTo(reader.value.catalog, target)) {
        const found = await reader.value.matching(schema.name, holds(field.name, id));
        if (!found.ok) return found;
        for (const r of found.value) {
          const done = field.cascadeDelete
            ? await d.collections.delete(ctx, schema.name, r.id)
            : await d.collections.update(ctx, schema.name, r.id, { [`${field.name}-`]: [id] });
          if (!done.ok && done.error.code !== 'NOT_FOUND') return done;
        }
      }
      return ok({ completed: false });
    },
  };
  const janitor: Worker = {
    kind: FILES_JOB,
    async run({ tenant, user }) {
      const swept = await d.files?.sweep(tenant, user.slice(COLLECTION_SCOPE.length));
      return swept && !swept.ok ? swept : ok({ completed: false });
    },
  };
  const views: Worker = {
    kind: VIEW_JOB,
    async run({ tenant, user }) {
      const source = user.slice(COLLECTION_SCOPE.length);
      const reader = await d.collections.reader(system(tenant));
      if (!reader.ok) return reader;
      for (const { schema } of reader.value.catalog.values()) {
        if (!schema.view || !viewSources(schema.view).includes(source)) continue;
        const done = await d.collections.refresh(reader.value, schema);
        if (!done.ok) return done;
      }
      return ok({ completed: false });
    },
  };
  const hooks = d.hooks;
  const clock = d.clock;
  if (!hooks || !clock) return [cascade, janitor, views];
  const after: Worker = {
    kind: HOOK_JOB,
    async run({ job }) {
      const ran = await hooks.run(JSON.parse(decoder.decode(job.payload)) as HookCall);
      return ran.ok ? ok({ completed: false }) : ran;
    },
  };
  const cron: Worker = {
    kind: CRON_JOB,
    async run({ tenant, job }) {
      const name = decoder.decode(job.payload);
      const ctx = system(tenant);
      const id = cronRecordId(name);
      const entry = hooks.crons().find((c) => c.name === name);
      if (!entry) {
        const removed = await d.collections.delete(ctx, CRON_COLLECTION, id);
        return removed.ok || removed.error.code === 'NOT_FOUND'
          ? ok({ completed: false })
          : removed;
      }
      const ran = await hooks.runCron(name);
      // A failing run must not end the schedule.
      if (!ran.ok) d.logger?.error('cron failed', { name, err: ran.error.message });
      const now = Number(clock.now());
      const next = cronJob(name, entry.expr, Math.max(now, Number(job.runAtMs)));
      const saved = await d.collections.update(
        ctx,
        CRON_COLLECTION,
        id,
        { expr: entry.expr, lastMs: now },
        next ? { enqueue: [next] } : {},
      );
      return saved.ok || saved.error.code === 'NOT_FOUND' ? ok({ completed: false }) : saved;
    },
  };
  return [cascade, janitor, views, after, cron];
}
