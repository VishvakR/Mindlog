import { describe, expect, test } from 'vitest';
import type { GraphReader } from '@mindlog/index-graph';
import { entityId, normalizeName, walk } from '@mindlog/index-graph';

describe('entity names', () => {
  test('normalisation folds case, width, spacing and edge punctuation', () => {
    expect(normalizeName('  Acme  Corp. ')).toBe('acme corp');
    expect(normalizeName('ＡＢＣ')).toBe('abc');
    expect(normalizeName('"Ana"')).toBe('ana');
  });

  test('the id is the type and the normalised name', () => {
    expect(entityId('person', 'Ana  Silva')).toBe('person:ana silva');
    expect(entityId('Person', 'ana silva')).toBe('person:ana silva');
  });
});

function reader(edges: ReadonlyArray<readonly [string, string, string]>): GraphReader {
  return {
    async *neighbors(node) {
      await Promise.resolve(); // a store read
      for (const [src, relation, dst] of edges) {
        if (src === node) yield { relation, node: dst, direction: 'out', weight: 1 };
        if (dst === node) yield { relation, node: src, direction: 'in', weight: 1 };
      }
    },
  };
}

describe('walk', () => {
  const g = reader([
    ['person:ana', 'works_at', 'org:acme'],
    ['org:acme', 'located_in', 'place:lisbon'],
    ['place:lisbon', 'in', 'place:portugal'],
    ['person:bob', 'knows', 'person:ana'],
  ]);

  test('depth 1 returns direct neighbours in both directions', async () => {
    const r = await walk(g, ['person:ana'], { depth: 1, limit: 100 });
    expect(r.nodes).toEqual([
      { id: 'person:ana', depth: 0 },
      { id: 'org:acme', depth: 1 },
      { id: 'person:bob', depth: 1 },
    ]);
    expect(r.edges).toEqual([
      { src: 'person:ana', relation: 'works_at', dst: 'org:acme', weight: 1 },
      { src: 'person:bob', relation: 'knows', dst: 'person:ana', weight: 1 },
    ]);
    expect(r.truncated).toBe(false);
  });

  test('depth 2 reaches two hops and no further', async () => {
    const r = await walk(g, ['person:ana'], { depth: 2, limit: 100 });
    expect(r.nodes.map((n) => n.id)).toContain('place:lisbon');
    expect(r.nodes.map((n) => n.id)).not.toContain('place:portugal');
  });

  test('the node limit bounds the walk and says so', async () => {
    const r = await walk(g, ['person:ana'], { depth: 2, limit: 2 });
    expect(r.nodes).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });

  test('depth is capped at 2', async () => {
    const r = await walk(g, ['person:ana'], { depth: 9, limit: 100 });
    expect(Math.max(...r.nodes.map((n) => n.depth))).toBe(2);
  });
});
