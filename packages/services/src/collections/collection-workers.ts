import { ok } from '@mindlog/core';
import { COLLECTION_SCOPE } from '@mindlog/jobs';
import type { Worker } from '@mindlog/jobs';
import { viewSources } from '@mindlog/collections';
import { CASCADE_JOB, FILES_JOB, VIEW_JOB, holds, referencesTo } from './collection-jobs.js';
import type { CollectionService } from './collection-service.js';
import type { RecordFiles } from './record-files.js';
import type { RequestContext } from './record-reader.js';

const decoder = new TextDecoder();

/** Durable work of collections (ADR-0034); each worker is idempotent. */
export function collectionWorkers(d: {
  readonly collections: CollectionService;
  readonly files?: RecordFiles;
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
  return [cascade, janitor, views];
}
