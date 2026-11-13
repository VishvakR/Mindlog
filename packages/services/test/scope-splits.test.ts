import type { MindlogError, Result } from '@mindlog/core';
import { ManualClock, err, mindlogError, ok } from '@mindlog/core';
import { describe, expect, test } from 'vitest';
import type { ClusterCall } from '../src/memory/scope-splits.js';
import { ScopeSplits } from '../src/memory/scope-splits.js';

type Handler = (input: Record<string, unknown>, cluster: number) => Result<unknown, MindlogError>;

/** A fake of the per-cluster call: answers by operation name, and records what was asked. */
function fake(handlers: Record<string, Handler>) {
  const asked: Array<{ name: string; cluster: number; input: Record<string, unknown> }> = [];
  const call: ClusterCall = <T>(
    name: string,
    input: Readonly<Record<string, unknown>>,
    c: number,
  ) => {
    asked.push({ name, cluster: c, input: { ...input } });
    const h = handlers[name];
    const r = h ? h({ ...input }, c) : err(mindlogError('NOT_FOUND', `no ${name}`));
    return Promise.resolve(r as Result<T, MindlogError>);
  };
  return { call, asked, on: (name: string) => asked.filter((a) => a.name === name) };
}

const notFound = () => err(mindlogError('NOT_FOUND', 'not here'));
const boom = () => err(mindlogError('UNAVAILABLE', 'down'));
const CLUSTERS = [0, 1, 2, 3];
const scope = { user: 'u' };
const splits = (fanout?: number) => new ScopeSplits(new ManualClock(), fanout);
const run = (name: string, input: Record<string, unknown>, f: ReturnType<typeof fake>) =>
  splits().run(name, { scope, ...input }, CLUSTERS, f.call);

const view = (id: string, text = id, trust = 'normal') => ({ id, text, kind: 'fact', trust });
const out = (...ids: string[]) => ({
  items: ids.map((id, i) => ({ memory: view(id), score: 1 / (i + 1), signals: {} })),
  context: '',
  tokens: 0,
  budget: 1000,
  groups: [],
  dropped: [],
  compressed: [],
  degraded: false,
});
const ranked =
  (clusters: number[], degraded = false) =>
  () =>
    ok({ clusters, degraded });

describe('recall', () => {
  const recalled = async (fanout: number | undefined, degraded = false) => {
    const f = fake({ route: ranked([3, 1, 2, 0], degraded), recall: () => ok(out()) });
    expect((await splits(fanout).run('recall', { scope, query: 'q' }, CLUSTERS, f.call)).ok).toBe(
      true,
    );
    return f
      .on('recall')
      .map((a) => a.cluster)
      .sort();
  };

  test('searches the nearest clusters, as many as the fan-out says', async () => {
    expect(await recalled(undefined)).toEqual([1, 3]);
    expect(await recalled(3)).toEqual([1, 2, 3]);
  });

  test('without a query embedding asks every cluster', async () => {
    expect(await recalled(2, true)).toEqual([0, 1, 2, 3]);
  });

  test('fuses rankings by rank, keeps one copy of a memory and honours k', async () => {
    const f = fake({
      route: ranked([1, 2]),
      recall: (_i, c) => ok(c === 1 ? out('a', 'b') : out('c', 'a')),
    });
    const r = await run('recall', { query: 'q', k: 2 }, f);
    const ids = (r.ok ? (r.value as ReturnType<typeof out>).items : []).map((i) => i.memory.id);
    expect(ids).toEqual(['a', 'c']);
  });

  test('a missing cluster is skipped, a failing one fails the recall', async () => {
    const skip = fake({
      route: ranked([1, 2]),
      recall: (_i, c) => (c === 1 ? notFound() : ok(out('x'))),
    });
    expect((await run('recall', { query: 'q' }, skip)).ok).toBe(true);
    const fail = fake({
      route: ranked([1, 2]),
      recall: (_i, c) => (c === 1 ? boom() : ok(out('x'))),
    });
    expect(await run('recall', { query: 'q' }, fail)).toMatchObject({ ok: false });
    const none = fake({ route: ranked([1, 2]), recall: notFound });
    const r = await run('recall', { query: 'q' }, none);
    expect(r.ok ? '' : r.error.code).toBe('UNAVAILABLE');
  });
});

describe('remember', () => {
  test('goes to the nearest cluster, or the root without an embedding', async () => {
    const near = fake({ route: ranked([2, 0]), remember: () => ok({ ids: ['m'] }) });
    await run('remember', { content: 'tea' }, near);
    expect(near.on('remember')[0]?.cluster).toBe(2);
    expect(near.on('route')[0]?.input).toMatchObject({ text: 'tea', kind: 'passage' });

    const degraded = fake({ route: ranked([2], true), remember: () => ok({ ids: [] }) });
    await run('remember', { content: 'tea' }, degraded);
    expect(degraded.on('remember')[0]?.cluster).toBe(0);

    const down = fake({ route: boom, remember: () => ok({ ids: [] }) });
    await run('remember', { content: 'tea' }, down);
    expect(down.on('remember')[0]?.cluster).toBe(0);
  });

  test('routes a tool trace by its text', async () => {
    const f = fake({ route: ranked([1]), remember: () => ok({ ids: [] }) });
    await run('remember', { toolTrace: { tool: 'search', args: {}, result: 'ok', ok: true } }, f);
    expect(String(f.on('route')[0]?.input.text)).toContain('search');
  });

  test('a derived memory goes where its least trusted parent lives', async () => {
    const where: Record<string, [number, string]> = { p1: [1, 'verified'], p2: [3, 'quarantined'] };
    const f = fake({
      get: (i, c) => {
        const at = where[String(i.id)];
        return at?.[0] === c ? ok(view(String(i.id), 'x', at[1])) : ok(undefined);
      },
      remember: () => ok({ ids: [] }),
    });
    await run('remember', { content: 'summary', derivedFrom: ['p1', 'p2'] }, f);
    expect(f.on('remember')[0]?.cluster).toBe(3);
    expect(f.on('route')).toHaveLength(0);
  });

  test('parents found nowhere fall back to routing', async () => {
    const f = fake({
      get: () => ok(undefined),
      route: ranked([2]),
      remember: () => ok({ ids: [] }),
    });
    await run('remember', { content: 'x', derivedFrom: ['gone'] }, f);
    expect(f.on('remember')[0]?.cluster).toBe(2);
  });
});

describe('reads that address every cluster', () => {
  test('get and resolve take the first cluster that has the id', async () => {
    const f = fake({ get: (_i, c) => (c === 2 ? ok(view('m')) : c === 0 ? ok(null) : notFound()) });
    expect(await run('get', { id: 'm' }, f)).toEqual(ok(view('m')));
    expect(f.on('get').map((a) => a.cluster)).toEqual([0, 1, 2]);

    const missing = fake({ resolve: notFound });
    expect((await run('resolve', { id: 'c' }, missing)).ok).toBe(false);
    const failing = fake({ get: boom });
    expect(await run('get', { id: 'm' }, failing)).toMatchObject({ ok: false });
    expect(failing.on('get')).toHaveLength(1);
  });

  test('getMany merges clusters and shows a memory in flight once', async () => {
    const f = fake({
      getMany: (_i, c) => ok({ memories: c < 2 ? [view('a'), view(`b${String(c)}`)] : [] }),
    });
    const r = await run('getMany', { ids: ['a'] }, f);
    expect(
      (r.ok ? (r.value as { memories: Array<{ id: string }> }).memories : []).map((m) => m.id),
    ).toEqual(['a', 'b0', 'b1']);
    expect((await run('getMany', { ids: [] }, fake({ getMany: boom }))).ok).toBe(false);
  });

  test('list pages through clusters with cluster cursors', async () => {
    const pages: Record<number, string[]> = { 0: ['a', 'b'], 1: ['b', 'c'], 2: [], 3: ['d', 'e'] };
    const f = fake({
      list: (i, c) => {
        const all = pages[c] ?? [];
        const from = typeof i.after === 'string' ? all.indexOf(i.after) + 1 : 0;
        const take = all.slice(from, from + Number(i.limit));
        const more = from + take.length < all.length;
        return ok({ memories: take.map((id) => ({ id })), ...(more ? { next: take.at(-1) } : {}) });
      },
    });
    const ids = (r: Result<unknown, MindlogError>) =>
      (r.ok ? (r.value as { memories: Array<{ id: string }> }).memories : []).map((m) => m.id);

    // A full page ends on a cluster boundary: the cursor names the next cluster.
    const first = await run('list', { limit: 2 }, f);
    expect(ids(first)).toEqual(['a', 'b']);
    expect(first.ok && (first.value as { next?: string }).next).toBe('c1:');

    // An empty cluster is passed over, and a cluster with more ends the page with its own cursor.
    const second = await run('list', { limit: 3, after: 'c1:' }, f);
    expect(ids(second)).toEqual(['b', 'c', 'd']);
    expect(second.ok && (second.value as { next?: string }).next).toBe('c3:d');
    const last = await run('list', { limit: 5, after: 'c3:d' }, f);
    expect(ids(last)).toEqual(['e']);
    expect(last.ok && (last.value as { next?: string }).next).toBeUndefined();

    // A memory in two clusters (mid-move) is shown once within a page.
    expect(ids(await run('list', { limit: 4 }, f))).toEqual(['a', 'b', 'c', 'd']);

    // An unknown cursor starts over rather than skipping data.
    expect(ids(await run('list', { limit: 2, after: 'c9:x' }, f))).toEqual(['a', 'b']);
    expect(ids(await run('list', { limit: 2, after: 'nonsense' }, f))).toEqual(['a', 'b']);
    expect((await run('list', {}, fake({ list: boom }))).ok).toBe(false);
  });

  test('conflicts page the same way', async () => {
    const f = fake({ conflicts: (_i, c) => ok({ conflicts: [{ id: `x${String(c)}` }] }) });
    const r = await run('conflicts', {}, f);
    expect(r.ok && (r.value as { conflicts: unknown[] }).conflicts).toHaveLength(4);
  });

  test('history merges clusters newest first and drops a moved copy', async () => {
    const entry = (revision: number, atMs: number, text: string) => ({
      version: '',
      revision,
      atMs,
      memory: view('m', text),
    });
    const f = fake({
      history: (_i, c) =>
        ok(
          c === 0
            ? [entry(1, 10, 'old'), entry(2, 20, 'new')]
            : c === 1
              ? [entry(2, 20, 'new')]
              : [],
        ),
    });
    const r = await run('history', { id: 'm' }, f);
    expect((r.ok ? (r.value as Array<{ revision: number }>) : []).map((e) => e.revision)).toEqual([
      2, 1,
    ]);
    expect((await run('history', { id: 'm' }, fake({ history: boom }))).ok).toBe(false);
  });

  test('graph merges nodes, edges and memories', async () => {
    const node = (depth: number) => ({ id: 'e:tea', name: 'tea', type: 'e', depth, mentions: 1 });
    const edge = { src: 'e:ann', relation: 'likes', dst: 'e:tea', weight: 1 };
    const f = fake({
      graph: (_i, c) =>
        ok({
          nodes: [node(c + 1)],
          edges: [edge],
          memories: [`m${String(c % 2)}`],
          truncated: c === 3,
        }),
    });
    const r = await run('graph', { entity: 'e:tea' }, f);
    expect(r.ok && r.value).toEqual({
      nodes: [{ ...node(1), mentions: 4 }],
      edges: [{ ...edge, weight: 4 }],
      memories: ['m0', 'm1'],
      truncated: true,
    });
    expect((await run('graph', {}, fake({ graph: boom }))).ok).toBe(false);
  });

  test('jobs sum the lifecycle counts and list every cluster', async () => {
    const f = fake({
      jobs: (_i, c) =>
        ok({ jobs: [`j${String(c)}`], lifecycle: { hot: 2, cold: 1, embedModel: 'x' } }),
    });
    const r = await run('jobs', {}, f);
    expect(r.ok && r.value).toMatchObject({
      jobs: ['j0', 'j1', 'j2', 'j3'],
      lifecycle: { hot: 8, cold: 4, writesSinceSleep: 0, clusters: 4, embedModel: 'x' },
    });
    const none = await run('jobs', {}, fake({ jobs: notFound }));
    expect(none.ok ? '' : none.error.code).toBe('NOT_FOUND');
    expect((await run('jobs', {}, fake({ jobs: boom }))).ok).toBe(false);
  });

  test('export needs at least one cluster to answer', async () => {
    const none = await run('export', {}, fake({ exportParts: notFound }));
    expect(none.ok ? '' : none.error.code).toBe('NOT_FOUND');
    expect((await run('export', {}, fake({ exportParts: boom }))).ok).toBe(false);
  });
});

describe('writes that address every cluster', () => {
  test('trust and pin are sent to all clusters and their answers unioned', async () => {
    const f = fake({ trust: (_i, c) => ok({ ids: c === 1 ? ['m'] : [], count: c === 1 ? 1 : 0 }) });
    expect(await run('trust', { ids: ['m'], trust: 'verified' }, f)).toEqual(
      ok({ ids: ['m'], count: 1 }),
    );
    expect(f.on('trust')).toHaveLength(4);
    expect((await run('pin', { ids: ['m'] }, fake({ pin: boom }))).ok).toBe(false);
  });

  test('consolidate enqueues on every cluster', async () => {
    const f = fake({ consolidate: (_i, c) => ok({ enqueued: [`w${String(c)}`] }) });
    expect(await run('consolidate', { workers: ['dedup'] }, f)).toEqual(
      ok({ enqueued: ['w0', 'w1', 'w2', 'w3'] }),
    );
    expect((await run('consolidate', {}, fake({ consolidate: boom }))).ok).toBe(false);
  });

  test('a forget by source follows derived memories across clusters', async () => {
    // a (cluster 0) → b (cluster 2) → c (cluster 3)
    const derived: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };
    const home: Record<string, number> = { a: 0, b: 2, c: 3 };
    const f = fake({
      forget: (i, c) => {
        const ids = i.source
          ? c === 0
            ? ['a']
            : []
          : (i.ids as string[]).filter((id) => home[id] === c);
        return ok({ ids, count: ids.length });
      },
      derived: (i) => ok((i.ids as string[]).flatMap((id) => derived[id] ?? [])),
    });
    const r = await run('forget', { source: 'web:x', reason: 'tainted' }, f);
    expect(r.ok && (r.value as { ids: string[] }).ids.sort()).toEqual(['a', 'b', 'c']);
    expect(f.on('forget').at(-1)?.input).toMatchObject({ reason: 'tainted' });

    const plain = fake({
      forget: (_i, c) => ok({ ids: c === 0 ? ['a'] : [], count: c === 0 ? 1 : 0 }),
    });
    expect(await run('forget', { ids: ['a'] }, plain)).toEqual(ok({ ids: ['a'], count: 1 }));
    expect(plain.on('derived')).toHaveLength(0);

    const cascadeFails = fake({ forget: () => ok({ ids: ['a'], count: 1 }), derived: boom });
    expect((await run('forget', { source: 's' }, cascadeFails)).ok).toBe(false);
    expect((await run('forget', { ids: ['a'] }, fake({ forget: boom }))).ok).toBe(false);
  });
});

describe('everything else', () => {
  test('branches and the semantic cache are refused', async () => {
    for (const name of ['branchCreate', 'cacheGet', 'cacheSet']) {
      const r = await run(name, {}, fake({}));
      expect(r.ok ? '' : r.error.code).toBe('INVALID_ARGUMENT');
    }
  });

  test('other operations go to the root', async () => {
    const f = fake({ import: () => ok({ imported: 1 }) });
    expect(await run('import', { data: '' }, f)).toEqual(ok({ imported: 1 }));
    expect(f.on('import')[0]?.cluster).toBe(0);
  });

  test('ASOF by index becomes the root range’s time', async () => {
    const f = fake({ asOfTime: () => ok({ time: 1234 }), get: () => ok(view('m')) });
    await run('get', { id: 'm', asOf: { index: '7' } }, f);
    expect(f.on('asOfTime')[0]?.cluster).toBe(0);
    expect(f.on('get')[0]?.input.asOf).toEqual({ time: 1234 });
    expect((await run('get', { id: 'm', asOf: { index: '7' } }, fake({ asOfTime: boom }))).ok).toBe(
      false,
    );
  });
});

describe('the layout cache', () => {
  test('reads a layout once per two seconds, and again after forget', async () => {
    const clock = new ManualClock();
    const s = new ScopeSplits(clock);
    let reads = 0;
    const read = () => {
      reads++;
      return Promise.resolve(ok({ clusters: reads === 1 ? [] : [0, 1] }));
    };
    expect(await s.clusters('t', 'u', read)).toEqual(ok([0]));
    expect(await s.clusters('t', 'u', read)).toEqual(ok([0]));
    expect(reads).toBe(1);
    clock.advance(2_001n);
    expect(await s.clusters('t', 'u', read)).toEqual(ok([0, 1]));
    s.forget('t', 'u');
    await s.clusters('t', 'u', read);
    expect(reads).toBe(3);
    const failed = await s.clusters('t', 'v', () => Promise.resolve(boom()));
    expect(failed.ok).toBe(false);
  });
});
