import { describe, expect, test } from 'vitest';
import type { RecallInput } from '@mindlog/memory';
import { inlinePpr } from '@mindlog/memory';
import { ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string): Promise<string> {
  const r = await n.engine.remember(n.range, { scope: scope(), content, kind: 'semantic' }, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.ids[0] as string;
}

async function recall(n: Node, query: string, extra: Partial<RecallInput> = {}) {
  const r = await n.engine.recall(n.range, { scope: scope(), query, explain: true, ...extra }, ctx);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Ana → (joined) Acme → (office) Porto: the Porto memory shares no word with a question about Ana. */
async function chain(n: Node) {
  const joined = await remember(n, 'Yesterday Ana joined Acme as an engineer.');
  const office = await remember(n, 'The main office of Acme sits near Porto.');
  const tea = await remember(n, 'I like green tea in the afternoon.');
  const weather = await remember(n, 'It rained all weekend long.');
  return { joined, office, tea, weather };
}

describe('ppr retriever', () => {
  test('reaches a memory two hops away through a shared entity', async () => {
    const n = await memoryNode();
    const m = await chain(n);
    const r = await recall(n, 'Where does Ana work?', { recipe: 'hybrid_ppr' });
    const ppr = r.explain?.lists.ppr ?? [];
    expect(ppr[0]).toBe(m.joined);
    expect(ppr).toContain(m.office);
    expect(ppr).not.toContain(m.tea);
    const office = r.items.find((i) => i.memory.id === m.office);
    expect(office?.signals.ppr).toBeGreaterThan(0);
    const rank = (id: string) => r.items.findIndex((i) => i.memory.id === id);
    expect(rank(m.office)).toBeLessThan(rank(m.tea));
  });

  test('without seeds it returns nothing', async () => {
    const n = await memoryNode();
    const r = await recall(n, 'anything at all', { recipe: 'hybrid_ppr' });
    expect(r.explain?.lists.ppr).toEqual([]);
  });

  test('runs the iteration through the injected runner', async () => {
    const sizes: number[] = [];
    const n = await memoryNode({
      ppr: (graph, seed, options) => {
        sizes.push(graph.ids.length);
        return inlinePpr(graph, seed, options);
      },
    });
    await chain(n);
    await recall(n, 'Where does Ana work?', { recipe: 'hybrid_ppr' });
    expect(sizes).toHaveLength(1);
    expect(sizes[0]).toBeGreaterThan(2);
  });

  test('the node cap bounds the sub-graph', async () => {
    const sizes: number[] = [];
    const n = await memoryNode({
      config: { pprMaxNodes: 3 },
      ppr: (graph, seed, options) => {
        sizes.push(graph.ids.length);
        return inlinePpr(graph, seed, options);
      },
    });
    await chain(n);
    await recall(n, 'Where does Ana work?', { recipe: 'hybrid_ppr' });
    expect(sizes).toEqual([3]);
  });
});

describe('theme retriever and routing', () => {
  test('a broad question gets the community of connected memories', async () => {
    const n = await memoryNode();
    const m = await chain(n);
    const r = await recall(n, 'summarize everything you know', { recipe: 'full' });
    expect(r.route).toBe('broad');
    const theme = r.explain?.themes.find((t) => t.ids.includes(m.office));
    expect(theme?.ids).toEqual(expect.arrayContaining([m.joined, m.office]));
    expect(theme?.label).toContain('acme');
    expect(r.explain?.lists.theme).toEqual(expect.arrayContaining([m.joined, m.office]));
  });

  test('a specific question skips themes; two entities make it multi-hop', async () => {
    const n = await memoryNode();
    await chain(n);
    expect((await recall(n, 'what tea do I like')).route).toBe('specific');
    expect((await recall(n, 'what tea do I like')).explain?.lists.theme).toBeUndefined();
    expect((await recall(n, 'How are Ana and Porto linked?')).route).toBe('multihop');
  });
});

describe('recipes', () => {
  test('rag scores by relevance alone and runs the vector retriever only', async () => {
    const n = await memoryNode();
    await chain(n);
    const r = await recall(n, 'green tea', { recipe: 'rag' });
    expect(r.recipe).toBe('rag');
    expect(Object.keys(r.explain?.lists ?? {})).toEqual(['vector']);
    for (const item of r.items) expect(item.score).toBe(item.signals.fused);
  });

  test('full reranks the candidates and reports the rerank signal', async () => {
    const n = await memoryNode();
    const m = await chain(n);
    const r = await recall(n, 'green tea afternoon');
    expect(r.recipe).toBe('full');
    expect(r.items[0]?.memory.id).toBe(m.tea);
    expect(r.items[0]?.signals.rerank).toBeGreaterThan(0);
    expect(Object.keys(r.explain?.lists ?? {}).sort()).toEqual([
      'entity',
      'keyword',
      'ppr',
      'vector',
    ]);
  });

  test('the packed context groups by kind and reports what was left out', async () => {
    const n = await memoryNode();
    await chain(n);
    const r = await recall(n, 'green tea', { tokenBudget: 20 });
    expect(r.context.startsWith('## Facts\n- ')).toBe(true);
    expect(r.tokens).toBeLessThanOrEqual(20);
    expect(r.budget).toBe(20);
    expect(r.groups[0]?.name).toBe('Facts');
    expect(r.dropped.length).toBeGreaterThan(0);
  });
});
