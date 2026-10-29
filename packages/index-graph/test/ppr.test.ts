import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Csr } from '@mindlog/index-graph';
import { communities, personalizedPageRank, toCsr } from '@mindlog/index-graph';

const graph = (ids: string[], edges: Array<[string, string, number?]>): Csr =>
  toCsr({
    nodes: ids.map((id) => ({ id, depth: 0 })),
    edges: edges.map(([src, dst, weight = 1]) => ({ src, relation: 'r', dst, weight })),
  });

const seedOf = (g: Csr, weights: Record<string, number>) =>
  Float64Array.from(g.ids, (id) => weights[id] ?? 0);

describe('toCsr', () => {
  test('is undirected and adds the weights of parallel edges', () => {
    const g = graph(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'a', 2],
        ['b', 'c'],
        ['c', 'x'],
      ],
    );
    expect([...g.offsets]).toEqual([0, 1, 3, 4]);
    expect([...g.targets]).toEqual([1, 0, 2, 1]);
    expect([...g.weights]).toEqual([3, 3, 1, 1]);
  });
});

describe('personalizedPageRank', () => {
  test('matches the closed form on a two-node graph', () => {
    // r_a = 0.5 + 0.5 r_b, r_b = 0.5 r_a → r_a = 2/3, r_b = 1/3.
    const g = graph(['a', 'b'], [['a', 'b']]);
    const r = personalizedPageRank(g, seedOf(g, { a: 1 }), {
      damping: 0.5,
      maxIterations: 100,
      tolerance: 1e-12,
    });
    expect(r[0]).toBeCloseTo(2 / 3, 9);
    expect(r[1]).toBeCloseTo(1 / 3, 9);
  });

  test('a node two hops away scores below a direct neighbour', () => {
    const g = graph(
      ['q', 'n1', 'n2', 'far'],
      [
        ['q', 'n1'],
        ['n1', 'n2'],
        ['n2', 'far'],
      ],
    );
    const r = personalizedPageRank(g, seedOf(g, { q: 1 }));
    expect(r[1]).toBeGreaterThan(r[2] as number);
    expect(r[2]).toBeGreaterThan(r[3] as number);
  });

  test('a seed without positive weight gives all zeros', () => {
    const g = graph(['a', 'b'], [['a', 'b']]);
    expect([...personalizedPageRank(g, seedOf(g, { a: -1 }))]).toEqual([0, 0]);
  });

  test('isolated seeds keep their mass', () => {
    const g = graph(['a', 'b'], []);
    const r = personalizedPageRank(g, seedOf(g, { a: 1, b: 3 }));
    expect(r[0]).toBeCloseTo(0.25, 9);
    expect(r[1]).toBeCloseTo(0.75, 9);
  });

  const arbitraryGraph = fc.integer({ min: 1, max: 12 }).chain((n) =>
    fc.record({
      n: fc.constant(n),
      edges: fc.array(
        fc.tuple(fc.nat(n - 1), fc.nat(n - 1), fc.double({ min: 0.1, max: 5, noNaN: true })),
        { maxLength: 30 },
      ),
      seed: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: n, maxLength: n }),
    }),
  );

  test('scores are a distribution and deterministic', () => {
    fc.assert(
      fc.property(arbitraryGraph, ({ n, edges, seed }) => {
        const ids = Array.from({ length: n }, (_, i) => `n${String(i)}`);
        const g = graph(
          ids,
          edges.map(([a, b, w]) => [`n${String(a)}`, `n${String(b)}`, w]),
        );
        const s = Float64Array.from(seed);
        const r = personalizedPageRank(g, s);
        const sum = r.reduce((x, y) => x + y, 0);
        if (s.some((x) => x > 0)) expect(sum).toBeCloseTo(1, 5);
        else expect(sum).toBe(0);
        expect([...personalizedPageRank(g, s)]).toEqual([...r]);
        for (const x of r) expect(x).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

describe('communities', () => {
  test('two cliques joined by one weak edge are two communities', () => {
    const g = graph(
      ['a1', 'a2', 'a3', 'b1', 'b2', 'b3'],
      [
        ['a1', 'a2'],
        ['a2', 'a3'],
        ['a1', 'a3'],
        ['b1', 'b2'],
        ['b2', 'b3'],
        ['b1', 'b3'],
        ['a3', 'b1', 0.1],
      ],
    );
    const labels = [...communities(g)];
    expect(new Set(labels.slice(0, 3)).size).toBe(1);
    expect(new Set(labels.slice(3)).size).toBe(1);
    expect(labels[0]).not.toBe(labels[3]);
  });

  test('an isolated node keeps its own label', () => {
    const g = graph(['a', 'b', 'c'], [['a', 'b']]);
    const labels = communities(g);
    expect(labels[2]).toBe(2);
    expect(labels[0]).toBe(labels[1]);
  });
});
