import { fromBinary } from '@bufbuild/protobuf';
import { entryPrefix } from '@mindlog/cache';
import { ok } from '@mindlog/core';
import type { Worker } from '@mindlog/jobs';
import { LIFECYCLE_JOBS, clusterIdOf } from '@mindlog/memory';
import { JobState } from '@mindlog/proto';
import { CacheEntrySchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { planTick } from '../schedule.js';
import type { ConsolidationDeps } from '../worker-kit.js';
import { worker } from '../worker-kit.js';

/**
 * The scope tick (ADR-0033): decides which workers are due, enqueues them,
 * completes itself and schedules the next tick, in one command.
 */
export function tickWorker(d: ConsolidationDeps): Worker {
  return worker(LIFECYCLE_JOBS.tick, d, async (run) => {
    const { engine } = d;
    const state = await engine.lifecycle(run.range, run.scope);
    const { jobs } = await engine.jobs(run.range, run.scope, { limit: 200 });
    const running = new Set(
      jobs
        .filter((j) => j.state === JobState.QUEUED || j.state === JobState.LEASED)
        .filter((j) => j.id !== run.job.job.id)
        .map((j) => j.kind),
    );
    let hasCache = false;
    for await (const { value } of new MvccReader(run.range.reader).scan(
      entryPrefix(run.scope.tenant, run.scope.user),
      { limit: 1 },
    ))
      hasCache = fromBinary(CacheEntrySchema, value).id !== '';
    const plan = planTick(state, run.nowMs, d.config, {
      running,
      hasCache,
      coldTier: d.cold !== undefined,
      split: state.clusters.length > 0 || clusterIdOf(run.scope.user) > 0,
    });
    if (plan.due.length > 0)
      d.logger.info('consolidation due', {
        tenant: run.scope.tenant,
        rangeId: String(run.range.rangeId),
        due: plan.due.map((x) => `${x.kind}: ${x.why}`).join('; '),
      });
    const tickId = run.job.job.id;
    const done = await run.maintain('tick', {
      tick: true,
      complete: { id: tickId, attempt: run.job.attempt },
      enqueue: plan.due.map((x) => ({
        id: `${x.kind.replace('consolidation.', '')}-${tickId}`,
        kind: x.kind,
        payload: new TextEncoder().encode(JSON.stringify({ why: x.why })),
      })),
      ...(plan.again
        ? {
            nextTick: {
              id: `tick-${d.ids.next()}`,
              kind: LIFECYCLE_JOBS.tick,
              runAtMs: run.nowMs + BigInt(d.config.tickMs),
            },
          }
        : {}),
    });
    return done.ok ? ok({ completed: true }) : done;
  });
}
