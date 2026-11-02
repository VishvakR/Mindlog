import { describe, expect, test } from 'vitest';
import { prefixRange } from '@mindlog/core';
import { MAX_ATTEMPTS, dueJobs, jobIndexPrefix, jobRangeHooks, queueDepth } from '@mindlog/jobs';
import { JobState } from '@mindlog/proto';
import { keyPrefix } from '@mindlog/core';
import { MemoryStore } from '@mindlog/storage';
import { START, TENANT, jobNode } from './support/job-node.js';

const lease = (id: string, leaseMs = 1000n, user = 'u1') =>
  ({ case: 'jobLease', value: { user, id, leaseMs } }) as const;
const complete = (id: string, attempt: number, error = '', user = 'u1') =>
  ({ case: 'jobComplete', value: { user, id, attempt, error } }) as const;

describe('job apply', () => {
  test('an enqueued job is queued and due at its run time', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', kind: 'memory.enrich', runAtMs: START + 50n });
    expect(await n.job('u1', 'j1')).toMatchObject({
      state: JobState.QUEUED,
      attempts: 0,
      kind: 'memory.enrich',
    });
    expect(await collect(dueJobs(n.store, 1n, START, 10))).toEqual([]);
    expect(await collect(dueJobs(n.store, 1n, START + 50n, 10))).toEqual([
      { tenant: TENANT, user: 'u1', id: 'j1', atMs: START + 50n },
    ]);
    expect(await queueDepth(n.store, 1n, 100)).toBe(1);
  });

  test('a lease is granted once, then again only after it expires', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1' });
    const first = await n.propose(lease('j1'));
    expect(first.outcome.case === 'job' && first.outcome.value).toMatchObject({
      attempt: 1,
      state: JobState.LEASED,
    });
    const again = await n.propose(lease('j1'));
    expect(again.outcome.case === 'error' && again.outcome.value.code).toBe('CONFLICT');
    n.clock.advance(1001n);
    const second = await n.propose(lease('j1'));
    expect(second.outcome.case === 'job' && second.outcome.value.attempt).toBe(2);
  });

  test('a job that is not due cannot be leased, and an unknown one is NOT_FOUND', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1', runAtMs: START + 10_000n });
    const early = await n.propose(lease('j1'));
    expect(early.outcome.case === 'error' && early.outcome.value.code).toBe('CONFLICT');
    const missing = await n.propose(lease('nope'));
    expect(missing.outcome.case === 'error' && missing.outcome.value.code).toBe('NOT_FOUND');
  });

  test('only the current lease can complete; done removes the job', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1' });
    await n.propose(lease('j1'));
    n.clock.advance(1001n);
    await n.propose(lease('j1')); // attempt 2 after the first lease expired
    const stale = await n.propose(complete('j1', 1));
    expect(stale.outcome.case === 'error' && stale.outcome.value.code).toBe('CONFLICT');
    const done = await n.propose(complete('j1', 2));
    expect(done.outcome.case === 'job' && done.outcome.value.state).toBe(JobState.DONE);
    expect(await n.job('u1', 'j1')).toBeUndefined();
    expect(await queueDepth(n.store, 1n, 100)).toBe(0);
  });

  test('failures back off exponentially, then the job is dead and kept', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1' });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const leased = await n.propose(lease('j1'));
      expect(leased.outcome.case === 'job' && leased.outcome.value.attempt).toBe(attempt);
      await n.propose(complete('j1', attempt, `boom ${String(attempt)}`));
      const job = await n.job('u1', 'j1');
      if (attempt < MAX_ATTEMPTS) {
        expect(job).toMatchObject({ state: JobState.QUEUED, error: `boom ${String(attempt)}` });
        expect((job?.runAtMs ?? 0n) - n.clock.now()).toBeGreaterThanOrEqual(
          1000n * 2n ** BigInt(attempt) - 5n,
        );
        n.clock.setWall((job?.runAtMs ?? 0n) + 1n);
      } else {
        expect(job).toMatchObject({ state: JobState.DEAD, error: `boom ${String(attempt)}` });
      }
    }
    expect(await queueDepth(n.store, 1n, 100)).toBe(0);
  });

  test('a deferred lease requeues the job without counting toward dead', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1' });
    for (let attempt = 1; attempt <= MAX_ATTEMPTS + 2; attempt++) {
      await n.propose(lease('j1'));
      const until = n.clock.now() + 5000n;
      await n.propose({
        case: 'jobComplete',
        value: { user: 'u1', id: 'j1', attempt, error: '', deferUntilMs: until },
      });
      expect(await n.job('u1', 'j1')).toMatchObject({
        state: JobState.QUEUED,
        deferrals: attempt,
        runAtMs: until,
      });
      n.clock.setWall(until);
    }
    await n.propose(lease('j1'));
    await n.propose(complete('j1', MAX_ATTEMPTS + 3, 'boom'));
    expect((await n.job('u1', 'j1'))?.state).toBe(JobState.QUEUED);
  });

  test('a commit can complete its own job atomically', async () => {
    const n = await jobNode();
    await n.enqueue('u1', { id: 'j1' });
    await n.propose(lease('j1'));
    await n.propose({
      case: 'memoryCommit',
      value: {
        user: 'u1',
        memories: [],
        edges: [],
        enqueue: [],
        complete: { id: 'j1', attempt: 1 },
      },
    });
    expect(await n.job('u1', 'j1')).toBeUndefined();
  });
});

describe('jobRangeHooks', () => {
  test('a split moves the index entries of jobs at or after the split key', async () => {
    const n = await jobNode();
    await n.enqueue('alice', { id: 'a1' });
    await n.enqueue('zed', { id: 'z1' });
    const split = keyPrefix(TENANT, 'm', ['m']);
    if (!split.ok) throw new Error('key');
    const batch: Array<[string, Uint8Array, Uint8Array?]> = [];
    const raw = {
      reader: n.store,
      batch: {
        put: (k: Uint8Array, v: Uint8Array) => batch.push(['put', k, v]),
        del: (k: Uint8Array) => batch.push(['del', k]),
      },
    };
    await jobRangeHooks.split(raw as never, 1n, 2n, split.value);
    const moved = new MemoryStore();
    const w = moved.batch();
    for (const [op, k, v] of batch) if (op === 'put' && v) w.put(k, v);
    await w.write();
    expect(await collect(dueJobs(moved, 2n, START + 1n, 10))).toEqual([
      { tenant: TENANT, user: 'zed', id: 'z1', atMs: START },
    ]);
    expect(batch.filter(([op]) => op === 'del')).toHaveLength(1);
    expect(prefixRange(jobIndexPrefix(1n)).start.length).toBeGreaterThan(0);
  });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
