import { describe, expect, test } from 'vitest';
import { memoryRange } from './support/memory-range.js';

describe('MemoryService', () => {
  test('remembers and recalls on a local leader', async () => {
    const m = await memoryRange();
    const added = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'I prefer dark roast coffee.',
    });
    expect(added.ok && added.value.memories.map((x) => x.text)).toEqual([
      'I prefer dark roast coffee.',
    ]);
    const found = await m.service.recall(m.caller, { scope: { user: 'u1' }, query: 'coffee' });
    expect(found.ok && found.value.items.map((i) => i.memory.text)).toEqual([
      'I prefer dark roast coffee.',
    ]);
    expect(m.forwarded).toEqual([]);
  });

  test('forwards to the leader, which validates the input again', async () => {
    const m = await memoryRange({ remote: true });
    const added = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'Ana lives in Lisbon.',
    });
    expect(added.ok).toBe(true);
    expect(m.forwarded.map((c) => c.kind === 'memory' && c.op)).toEqual(['layout', 'remember']);
    const id = added.ok ? (added.value.ids[0] ?? '') : '';
    const got = await m.service.get(m.caller, { scope: { user: 'u1' }, id });
    expect(got.ok && got.value?.text).toBe('Ana lives in Lisbon.');
  });

  test('a write retried after NOT_LEADER keeps its request id and applies once', async () => {
    const m = await memoryRange({ remote: true, refuseFirst: true });
    const added = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'I prefer tea',
      kind: 'semantic',
    });
    expect(added.ok).toBe(true);
    const [first, second] = m.forwarded;
    expect(first?.kind === 'memory' && second?.kind === 'memory' && first.requestId).toEqual(
      second?.kind === 'memory' ? second.requestId : undefined,
    );
    const list = await m.service.list(m.caller, { scope: { user: 'u1' } });
    expect(list.ok && list.value.memories).toHaveLength(1);
  });

  test('invalid input is INVALID_ARGUMENT with the field', async () => {
    const m = await memoryRange();
    const r = await m.service.recall(m.caller, { scope: { user: 'u1' }, query: '', k: 500 });
    expect(!r.ok && r.error.code).toBe('INVALID_ARGUMENT');
    expect(!r.ok && Object.keys(r.error.fields ?? {}).sort()).toEqual(['k', 'query']);
  });

  test('writes wait for the cluster version that knows memory commands', async () => {
    const m = await memoryRange({ clusterVersion: 4 });
    const r = await m.service.remember(m.caller, { scope: { user: 'u1' }, content: 'x y z' });
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
    const read = await m.service.recall(m.caller, { scope: { user: 'u1' }, query: 'x' });
    expect(read.ok).toBe(true);
  });

  test('forwarded time-travel and validity options parse the same on the leader', async () => {
    const m = await memoryRange({ remote: true });
    await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'Ana lives in Lisbon.',
      kind: 'semantic',
      validFrom: '2020-01-01',
    });
    for (const asOf of [{ index: 1 }, { index: '99' }, { time: '2030-01-01T00:00:00Z' }]) {
      const r = await m.service.recall(m.caller, {
        scope: { user: 'u1' },
        query: 'Ana',
        asOf,
        validAt: '2021-06-01',
      });
      expect(r.ok).toBe(true);
    }
    const list = await m.service.list(m.caller, { scope: { user: 'u1' }, asOf: { index: 1 } });
    expect(list.ok && list.value.memories).toEqual([]);
  });

  test('conflict review and trust need cluster version 7', async () => {
    const m = await memoryRange({ clusterVersion: 6 });
    const r = await m.service.trust(m.caller, {
      scope: { user: 'u1' },
      ids: ['x'],
      trust: 'normal',
    });
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
    const read = await m.service.conflicts(m.caller, { scope: { user: 'u1' } });
    expect(read.ok && read.value.conflicts).toEqual([]);
  });

  test.each([false, true])(
    'lists the scopes that hold memory (bare ranges: %s)',
    async (bareRanges) => {
      const m = await memoryRange({ bareRanges });
      for (const user of ['bob', 'alice', ''])
        await m.service.remember(m.caller, {
          scope: { user },
          content: 'some fact here',
          kind: 'semantic',
        });
      const scopes = await m.service.scopes(m.caller, {});
      expect(scopes.ok && scopes.value.users).toEqual(['', 'alice', 'bob']);
    },
  );

  test('forget and graph run through the same route', async () => {
    const m = await memoryRange({ remote: true });
    const added = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'My sister Ana lives in Lisbon.',
    });
    const id = added.ok ? (added.value.ids[0] ?? '') : '';
    const graph = await m.service.graph(m.caller, { scope: { user: 'u1' }, entity: 'Ana' });
    expect(graph.ok && graph.value.memories).toEqual([id]);
    const forgot = await m.service.forget(m.caller, { scope: { user: 'u1' }, ids: [id] });
    expect(forgot.ok && forgot.value.count).toBe(1);
    const history = await m.service.history(m.caller, { scope: { user: 'u1' }, id });
    expect(history.ok && history.value).toHaveLength(2);
  });
});

describe('MemoryService lifecycle', () => {
  test('pin, consolidate and jobs go through the route; writes need cluster version 8', async () => {
    const m = await memoryRange({ remote: true });
    const added = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      content: 'Ana lives in Lisbon.',
      kind: 'semantic',
    });
    const id = added.ok ? (added.value.ids[0] ?? '') : '';
    const pinned = await m.service.pin(m.caller, { scope: { user: 'u1' }, ids: [id] });
    expect(pinned.ok && pinned.value.count).toBe(1);
    const got = await m.service.get(m.caller, { scope: { user: 'u1' }, id });
    expect(got.ok && got.value?.pinned).toBe(true);
    const run = await m.service.consolidate(m.caller, {
      scope: { user: 'u1' },
      workers: ['dedup', 'forget'],
    });
    expect(run.ok && run.value.enqueued).toEqual(['consolidation.dedup', 'consolidation.forget']);
    const jobs = await m.service.jobs(m.caller, { scope: { user: 'u1' } });
    expect(jobs.ok && jobs.value.jobs.map((j) => j.kind).sort()).toEqual([
      'consolidation.dedup',
      'consolidation.forget',
      'consolidation.tick',
    ]);
    expect(jobs.ok && jobs.value.lifecycle).toMatchObject({ hot: 1, cold: 0 });
    expect(jobs.ok && jobs.value.jobs[0]?.why).toBeDefined();

    const old = await memoryRange({ clusterVersion: 7 });
    const refused = await old.service.pin(old.caller, { scope: { user: 'u1' }, ids: ['x'] });
    expect(!refused.ok && refused.error.code).toBe('UNAVAILABLE');
  });

  test('a scope exports and imports as a memory cube through the service', async () => {
    const m = await memoryRange({ remote: true });
    for (const content of ['Ana lives in Lisbon.', 'Ana works at Acme.'])
      await m.service.remember(m.caller, { scope: { user: 'u1' }, content, kind: 'semantic' });
    const cube = await m.service.exportCube(m.caller, { scope: { user: 'u1' } });
    expect(cube.ok && cube.value.bytes).toBeGreaterThan(100);
    if (!cube.ok) return;
    const imported = await m.service.importCube(m.caller, {
      scope: { user: 'u2' },
      data: cube.value.data,
      name: 'u1 backup',
    });
    expect(imported.ok && imported.value).toMatchObject({ imported: 2, skipped: 0 });
    const bad = await m.service.importCube(m.caller, { scope: { user: 'u2' }, data: 'AAAA' });
    expect(!bad.ok && bad.error.code).toBe('INVALID_ARGUMENT');
  });

  test('a tool trace is remembered without content', async () => {
    const m = await memoryRange();
    const r = await m.service.remember(m.caller, {
      scope: { user: 'u1' },
      toolTrace: { tool: 'deploy', args: { env: 'prod' }, success: false, result: 'timeout' },
    });
    expect(r.ok && r.value.memories[0]?.kind).toBe('tool_trace');
    const empty = await m.service.remember(m.caller, { scope: { user: 'u1' } });
    expect(!empty.ok && empty.error.code).toBe('INVALID_ARGUMENT');
  });
});

describe('MemoryService tenants', () => {
  test('reserved tenants are refused', async () => {
    const m = await memoryRange();
    for (const tenant of ['$system', '$node', '']) {
      const r = await m.service.recall(
        { tenant, principal: 'p' },
        { scope: { user: 'u' }, query: 'x' },
      );
      expect(!r.ok && r.error.code).toBe('INVALID_ARGUMENT');
    }
  });
});
