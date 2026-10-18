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
    expect(m.forwarded.map((c) => c.kind === 'memory' && c.op)).toEqual(['remember']);
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

  test('lists the scopes that hold memory', async () => {
    const m = await memoryRange();
    for (const user of ['bob', 'alice', ''])
      await m.service.remember(m.caller, {
        scope: { user },
        content: 'some fact here',
        kind: 'semantic',
      });
    const scopes = await m.service.scopes(m.caller, {});
    expect(scopes.ok && scopes.value.users).toEqual(['', 'alice', 'bob']);
  });

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
