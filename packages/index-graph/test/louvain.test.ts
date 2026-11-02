import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Csr } from '@mindlog/index-graph';
import { louvain, toCsr } from '@mindlog/index-graph';

const graph = (ids: string[], edges: Array<[string, string, number?]>): Csr =>
  toCsr({
    nodes: ids.map((id) => ({ id, depth: 0 })),
    edges: edges.map(([src, dst, weight = 1]) => ({ src, relation: 'r', dst, weight })),
  });

const clique = (p: string, n: number): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([`${p}${i}`, `${p}${j}`]);
  return out;
};

describe('louvain', () => {
  test('three cliques joined by single edges are three communities', () => {
    const ids = ['a', 'b', 'c'].flatMap((p) => [0, 1, 2, 3].map((i) => `${p}${i}`));
    const g = graph(ids, [
      ...clique('a', 4),
      ...clique('b', 4),
      ...clique('c', 4),
      ['a3', 'b0'],
      ['b3', 'c0'],
    ]);
    const c = louvain(g);
    expect([...c]).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
  });

  test('isolated nodes stay alone and an empty graph has no communities', () => {
    expect([...louvain(graph(['x', 'y'], []))]).toEqual([0, 1]);
    expect([...louvain(graph([], []))]).toEqual([]);
  });

  test('is deterministic and labels are compact', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.nat(11), fc.nat(11), fc.integer({ min: 1, max: 5 })), {
          maxLength: 40,
        }),
        (edges) => {
          const ids = Array.from({ length: 12 }, (_, i) => `n${String(i)}`);
          const g = graph(
            ids,
            edges.map(([a, b, w]) => [`n${String(a)}`, `n${String(b)}`, w]),
          );
          const one = louvain(g);
          expect([...louvain(g)]).toEqual([...one]);
          const max = Math.max(-1, ...one);
          for (let l = 0; l <= max; l++) expect(one.includes(l)).toBe(true);
          // Nodes joined by an edge of a connected pair end up somewhere; every label is used.
          expect(one.length).toBe(12);
        },
      ),
    );
  });
});
