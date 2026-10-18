import { describe, expect, test } from 'vitest';
import { JobRunner, WorkerRegistry } from '@mindlog/jobs';
import { ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string, extra: Record<string, unknown> = {}) {
  const r = await n.engine.remember(n.range, { scope: scope(), content, ...extra }, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

async function recall(n: Node, query: string, extra: Record<string, unknown> = {}) {
  const r = await n.engine.recall(n.range, { scope: scope(), query, ...extra }, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function runner(n: Node) {
  const workers = new WorkerRegistry();
  workers.register(n.engine.enrichWorker());
  return new JobRunner({
    rangeId: 1n,
    state: n.store,
    proposer: n.replica,
    stamper: n.stamper,
    active: () => true,
    clock: n.clock,
    logger: n.logger,
    metrics: n.metrics,
    workers,
  });
}

describe('remember', () => {
  test('extracts facts, links entities and embeds them', async () => {
    const n = await memoryNode();
    const out = await remember(n, 'Hi! I prefer dark roast coffee. My sister Ana lives in Lisbon.');
    expect(out.degraded).toBe(false);
    expect(out.memories.map((m) => [m.kind, m.text])).toEqual([
      ['semantic', 'I prefer dark roast coffee.'],
      ['semantic', 'My sister Ana lives in Lisbon.'],
    ]);
    expect(out.memories[1]?.entities).toEqual(expect.arrayContaining(['person:ana']));
    expect(out.memories[0]?.importance).toBeGreaterThan(out.memories[1]?.importance ?? 1);
    expect(out.jobId).toBeUndefined();
  });

  test('a given kind is stored verbatim, without extraction', async () => {
    const n = await memoryNode();
    const out = await remember(n, 'Ran the deploy at 10:00?', { kind: 'episodic' });
    expect(out.memories.map((m) => [m.kind, m.text])).toEqual([
      ['episodic', 'Ran the deploy at 10:00?'],
    ]);
  });

  test('a new memory links to similar existing ones', async () => {
    const n = await memoryNode();
    const first = await remember(n, 'I prefer dark roast coffee', { kind: 'semantic' });
    const second = await remember(n, 'I prefer dark roast coffee, always', { kind: 'semantic' });
    const links = second.memories[0]?.links ?? [];
    expect(links.map((l) => [l.to, l.relation])).toEqual([[first.ids[0], 'related']]);
    expect(links[0]?.weight).toBeGreaterThanOrEqual(0.75);
  });

  test('web content is quarantined and recalled only on request', async () => {
    const n = await memoryNode();
    await remember(n, 'The capital of Mars is Olympus', {
      kind: 'semantic',
      source: { type: 'web' },
    });
    expect((await recall(n, 'capital of Mars')).items).toEqual([]);
    const shown = await recall(n, 'capital of Mars', { includeQuarantined: true });
    expect(shown.items.map((i) => i.memory.trust)).toEqual(['quarantined']);
  });

  test('empty or oversized content is invalid', async () => {
    const n = await memoryNode();
    const empty = await n.engine.remember(n.range, { scope: scope(), content: '  \u0000 ' }, ctx);
    expect(!empty.ok && empty.error.code).toBe('INVALID_ARGUMENT');
    const big = await n.engine.remember(
      n.range,
      { scope: scope(), content: 'x'.repeat(40_000) },
      ctx,
    );
    expect(!big.ok && big.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('recall', () => {
  test('finds the relevant memory first, with per-signal scores and packed context', async () => {
    const n = await memoryNode();
    await remember(
      n,
      'I prefer dark roast coffee. My sister Ana lives in Lisbon. The train was late again.',
    );
    const r = await recall(n, 'what coffee do I prefer', { tokenBudget: 50 });
    expect(r.degraded).toBe(false);
    expect(r.items[0]?.memory.text).toBe('I prefer dark roast coffee.');
    expect(r.items[0]?.signals.vector).toBeGreaterThan(0);
    expect(r.items[0]?.signals.keyword).toBeGreaterThan(0);
    expect(r.context).toContain('I prefer dark roast coffee.');
    expect(r.tokens).toBeLessThanOrEqual(50);
  });

  test('entity matches are a signal of their own', async () => {
    const n = await memoryNode();
    await remember(n, 'My sister Ana lives in Lisbon. I prefer tea.');
    const r = await recall(n, 'where does Ana live');
    expect(r.items[0]?.memory.text).toContain('Ana');
    expect(r.items[0]?.signals.entity).toBeGreaterThan(0);
  });

  test('a scope sees its own and, with inherit, its ancestors', async () => {
    const n = await memoryNode();
    await n.engine.remember(
      n.range,
      { scope: scope('u1'), content: 'User likes jazz music', kind: 'semantic' },
      ctx,
    );
    await n.engine.remember(
      n.range,
      {
        scope: scope('u1', { agent: 'a1' }),
        content: 'Agent one likes jazz music',
        kind: 'semantic',
      },
      ctx,
    );
    await n.engine.remember(
      n.range,
      {
        scope: scope('u1', { agent: 'a2' }),
        content: 'Agent two likes jazz music',
        kind: 'semantic',
      },
      ctx,
    );
    const own = await n.engine.recall(
      n.range,
      { scope: scope('u1', { agent: 'a1' }), query: 'jazz music' },
      ctx,
    );
    expect(own.ok && own.value.items.map((i) => i.memory.text)).toEqual([
      'Agent one likes jazz music',
    ]);
    const inherited = await n.engine.recall(
      n.range,
      { scope: scope('u1', { agent: 'a1' }), query: 'jazz music', inherit: true },
      ctx,
    );
    expect(inherited.ok && inherited.value.items.map((i) => i.memory.text).sort()).toEqual([
      'Agent one likes jazz music',
      'User likes jazz music',
    ]);
    const user = await n.engine.recall(n.range, { scope: scope('u1'), query: 'jazz music' }, ctx);
    expect(user.ok && user.value.items).toHaveLength(3);
  });
});

describe('degraded mode', () => {
  test('without models the raw text is stored as episodic with an enrich job, and recall uses keywords', async () => {
    const n = await memoryNode();
    n.models.down = true;
    const out = await remember(n, 'I prefer dark roast coffee. My sister Ana lives in Lisbon.');
    expect(out.degraded).toBe(true);
    expect(out.memories.map((m) => m.kind)).toEqual(['episodic']);
    expect(out.jobId).toBeDefined();
    const r = await recall(n, 'dark roast coffee');
    expect(r.degraded).toBe(true);
    expect(r.items[0]?.signals.vector).toBeUndefined();
    expect(r.items[0]?.signals.keyword).toBeGreaterThan(0);
  });

  test('once the models are back, the enrich job derives facts from the episodic memory', async () => {
    const n = await memoryNode();
    n.models.down = true;
    const out = await remember(n, 'I prefer dark roast coffee. My sister Ana lives in Lisbon.');
    const jobs = runner(n);
    await jobs.runOnce(); // still down: the attempt fails and backs off
    n.models.down = false;
    n.clock.advance(10_000n);
    expect(await jobs.runOnce()).toBe(1);
    const list = await n.engine.list(n.range, scope(), { limit: 10 });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const derived = list.value.memories.filter((m) => m.kind === 'semantic');
    expect(derived.map((m) => m.text)).toEqual([
      'I prefer dark roast coffee.',
      'My sister Ana lives in Lisbon.',
    ]);
    expect(derived[0]?.links).toContainEqual({
      to: out.ids[0],
      relation: 'derived_from',
      weight: 1,
    });
  });

  test('async remember acknowledges first and enriches in a job', async () => {
    const n = await memoryNode();
    const out = await remember(n, 'I prefer dark roast coffee.', { async: true });
    expect(out.degraded).toBe(false);
    expect(out.memories.map((m) => m.kind)).toEqual(['episodic']);
    expect(out.jobId).toBeDefined();
    expect(await runner(n).runOnce()).toBe(1);
    const r = await recall(n, 'dark roast coffee', { kinds: ['semantic'] });
    expect(r.items.map((i) => i.memory.text)).toEqual(['I prefer dark roast coffee.']);
  });
});

describe('get, forget, history, list and graph', () => {
  test('forget hides a memory from recall and keeps its history', async () => {
    const n = await memoryNode();
    const out = await remember(n, 'I prefer dark roast coffee', { kind: 'semantic' });
    const id = out.ids[0] ?? '';
    const forgot = await n.engine.forget(
      n.range,
      { scope: scope(), ids: [id], reason: 'asked' },
      ctx,
    );
    expect(forgot.ok && forgot.value.count).toBe(1);
    expect((await recall(n, 'dark roast coffee')).items).toEqual([]);
    const got = await n.engine.get(n.range, scope(), id);
    expect(got.ok && got.value?.expiredAtMs).toBeGreaterThan(0);
    const history = await n.engine.history(n.range, scope(), id);
    expect(history.ok && history.value.map((h) => h.memory.expiredAtMs === undefined)).toEqual([
      false,
      true,
    ]);
  });

  test('list pages through a scope and skips forgotten memories by default', async () => {
    const n = await memoryNode();
    for (const t of ['one fact here', 'two facts here', 'three facts here'])
      await remember(n, t, { kind: 'semantic' });
    const first = await n.engine.list(n.range, scope(), { limit: 2 });
    expect(first.ok && first.value.memories).toHaveLength(2);
    const next = first.ok ? first.value.next : undefined;
    expect(next).toBeDefined();
    const second = await n.engine.list(n.range, scope(), { limit: 2, after: next });
    expect(second.ok && second.value.memories).toHaveLength(1);
    expect(second.ok && second.value.next).toBeUndefined();
  });

  test('graph returns the entity, its neighbourhood and the memories that mention it', async () => {
    const n = await memoryNode();
    const out = await remember(n, 'My sister Ana lives in Lisbon.');
    const g = await n.engine.graph(n.range, scope(), 'Ana', 1);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.nodes[0]).toMatchObject({
      id: 'person:ana',
      name: 'Ana',
      depth: 0,
      mentions: 1,
    });
    expect(g.value.memories).toEqual(out.ids);
    const missing = await n.engine.graph(n.range, scope(), 'Nobody', 1);
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
  });
});

describe('entities and edges without an LLM', () => {
  test('entities named in the same memory are linked as mentioned_with', async () => {
    const n = await memoryNode();
    await remember(n, 'My sister Ana works at Acme in Lisbon.');
    const g = await n.engine.graph(n.range, scope(), 'Ana', 1);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.nodes.map((x) => x.name).sort()).toEqual(['Acme', 'Ana', 'Lisbon']);
    expect(g.value.edges.map((e) => e.relation)).toEqual(['mentioned_with', 'mentioned_with']);
  });

  test('pronouns and one-letter spans are not entities', async () => {
    const n = await memoryNode();
    n.models.recognize = (texts) =>
      Promise.resolve({
        ok: true,
        value: {
          modelId: 'stub',
          spans: texts.map((t) => [
            { start: 0, end: 1, text: t.slice(0, 1), label: 'person', score: 0.9 },
            { start: 0, end: 2, text: 'me', label: 'person', score: 0.9 },
            { start: 0, end: 3, text: 'Ana', label: 'person', score: 0.9 },
          ]),
        },
      });
    const out = await remember(n, 'I told Ana about the plan.');
    expect(out.memories[0]?.entities).toEqual(['person:ana']);
  });
});
