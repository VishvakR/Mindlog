import { describe, expect, test } from 'vitest';
import { err, mindlogError, ok } from '@mindlog/core';
import type { LeasedJob, Worker } from '@mindlog/jobs';
import { JobRunner, WorkerRegistry } from '@mindlog/jobs';
import { JobState } from '@mindlog/proto';
import { jobNode } from './support/job-node.js';

function runner(n: Awaited<ReturnType<typeof jobNode>>, workers: Worker[], active = () => true) {
  const registry = new WorkerRegistry();
  for (const w of workers) registry.register(w);
  return new JobRunner({
    rangeId: 1n,
    state: n.store,
    proposer: n.replica,
    stamper: n.stamper,
    active,
    clock: n.clock,
    logger: n.logger,
    metrics: n.metrics,
    workers: registry,
    leaseMs: 5000,
  });
}

describe('JobRunner', () => {
  test('leases due jobs, runs their worker and completes them', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', kind: 'echo', payload: new TextEncoder().encode('hi') });
    const seen: LeasedJob[] = [];
    const r = runner(n, [
      {
        kind: 'echo',
        run: (job) => {
          seen.push(job);
          return Promise.resolve(ok({ completed: false }));
        },
      },
    ]);
    expect(await r.runOnce()).toBe(1);
    expect(
      seen.map((j) => [
        j.tenant,
        j.user,
        j.job.id,
        j.attempt,
        new TextDecoder().decode(j.job.payload),
      ]),
    ).toEqual([['default', 'u1', 'j1', 1, 'hi']]);
    expect(await n.job('u1', 'j1')).toBeUndefined();
    expect(n.metrics.observations('mindlog_jobs_run_seconds', { kind: 'echo' })).toHaveLength(1);
  });

  test('a worker error is recorded as a failed attempt', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', kind: 'flaky' });
    const r = runner(n, [
      {
        kind: 'flaky',
        run: () => Promise.resolve(err(mindlogError('UNAVAILABLE', 'models down'))),
      },
    ]);
    await r.runOnce();
    expect(await n.job('u1', 'j1')).toMatchObject({
      state: JobState.QUEUED,
      attempts: 1,
      error: 'UNAVAILABLE: models down',
    });
  });

  test('a worker that completes the job itself is not completed twice', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', kind: 'self' });
    const r = runner(n, [
      {
        kind: 'self',
        run: async (job) => {
          await n.propose({
            case: 'memoryCommit',
            value: {
              user: job.user,
              memories: [],
              edges: [],
              enqueue: [],
              complete: { id: job.job.id, attempt: job.attempt },
            },
          });
          return ok({ completed: true });
        },
      },
    ]);
    await r.runOnce();
    expect(await n.job('u1', 'j1')).toBeUndefined();
    expect(n.logger.entries.filter((e) => e.level === 'warn')).toEqual([]);
  });

  test('a job of an unknown kind fails, and nothing runs while inactive', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', kind: 'unknown' });
    expect(await runner(n, [], () => false).runOnce()).toBe(0);
    expect(await n.job('u1', 'j1')).toMatchObject({ attempts: 0 });
    await runner(n, []).runOnce();
    const failed = await n.job('u1', 'j1');
    expect(failed?.attempts).toBe(1);
    expect(failed?.error).toContain('no worker');
  });
});
