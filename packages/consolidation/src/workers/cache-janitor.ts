import { fromBinary } from '@bufbuild/protobuf';
import { entryPrefix } from '@mindlog/cache';
import { ok } from '@mindlog/core';
import type { Worker } from '@mindlog/jobs';
import { LIFECYCLE_JOBS } from '@mindlog/memory';
import { CacheEntrySchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import type { ConsolidationDeps } from '../worker-kit.js';
import { worker } from '../worker-kit.js';

/** Entries one janitor run drops at most. */
const BATCH = 500;

/** CacheJanitor (PLAN 12.6): drops the scope's expired semantic-cache entries. */
export function cacheJanitor(d: ConsolidationDeps): Worker {
  return worker(LIFECYCLE_JOBS.cache, d, async (run) => {
    const expired: string[] = [];
    for await (const { value } of new MvccReader(run.range.reader).scan(
      entryPrefix(run.scope.tenant, run.scope.user),
    )) {
      const e = fromBinary(CacheEntrySchema, value);
      if (e.expiresAtMs !== 0n && e.expiresAtMs <= run.nowMs) expired.push(e.id);
      if (expired.length >= BATCH) break;
    }
    if (expired.length > 0) {
      const done = await d.engine.invalidateCache(run.range, run.scope, expired, run.context(1));
      if (!done.ok) return done;
    }
    return ok({ completed: false });
  });
}
