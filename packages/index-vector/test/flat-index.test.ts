import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import type { VectorIndex } from '@mindlog/index-vector';
import { FlatIndex } from '@mindlog/index-vector';

function unit(values: readonly number[]): Float32Array {
  const v = Float32Array.from(values);
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return v.map((x) => x / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Behaviour every VectorIndex must have (CLAUDE.md §3.3). */
function describeVectorIndexContract(name: string, make: (dims: number) => VectorIndex<string>) {
  describe(`VectorIndex contract: ${name}`, () => {
    test('nearest first, with cosine scores', () => {
      const index = make(2);
      index.upsert('east', unit([1, 0]), 'a');
      index.upsert('north', unit([0, 1]), 'a');
      index.upsert('north-east', unit([1, 1]), 'a');
      const hits = index.search(unit([1, 0.1]), 2);
      expect(hits.map((h) => h.id)).toEqual(['east', 'north-east']);
      expect(hits[0]?.score).toBeCloseTo(dot(unit([1, 0]), unit([1, 0.1])), 5);
    });

    test('upsert replaces, remove forgets, size follows', () => {
      const index = make(2);
      index.upsert('x', unit([1, 0]), 'a');
      index.upsert('y', unit([0, 1]), 'a');
      index.upsert('x', unit([0, 1]), 'b');
      expect(index.size).toBe(2);
      expect(index.remove('y')).toBe(true);
      expect(index.remove('y')).toBe(false);
      expect(index.size).toBe(1);
      const hits = index.search(unit([0, 1]), 5);
      expect(hits.map((h) => h.id)).toEqual(['x']);
      expect(hits[0]?.score).toBeCloseTo(1, 5);
    });

    test('the filter runs during the search, so k results still come back', () => {
      const index = make(2);
      for (let i = 0; i < 20; i++)
        index.upsert(`m${String(i)}`, unit([1, i / 20]), i % 2 ? 'odd' : 'even');
      const hits = index.search(unit([1, 0]), 5, (meta) => meta === 'odd');
      expect(hits).toHaveLength(5);
      expect(hits.every((h) => Number(h.id.slice(1)) % 2 === 1)).toBe(true);
    });

    test('equal scores are ordered by id, so every replica answers the same', () => {
      const index = make(2);
      for (const id of ['c', 'a', 'b']) index.upsert(id, unit([1, 0]), 'a');
      expect(index.search(unit([1, 0]), 3).map((h) => h.id)).toEqual(['a', 'b', 'c']);
    });

    test('a vector of the wrong size is a programmer error', () => {
      expect(() => {
        make(3).upsert('x', unit([1, 0]), 'a');
      }).toThrow(/3 dimensions/);
    });
  });
}

describeVectorIndexContract('FlatIndex', (dims) => new FlatIndex<string>(dims));

describe('FlatIndex', () => {
  test('matches a brute-force sort (property)', () => {
    const vec = fc.array(fc.float({ min: -1, max: 1, noNaN: true }), {
      minLength: 4,
      maxLength: 4,
    });
    fc.assert(
      fc.property(
        fc.array(vec, { minLength: 1, maxLength: 40 }),
        vec,
        fc.integer({ min: 1, max: 10 }),
        (rows, query, k) => {
          const index = new FlatIndex<null>(4);
          const stored = rows.map((r, i) => ({ id: `v${String(i).padStart(3, '0')}`, v: unit(r) }));
          for (const { id, v } of stored) index.upsert(id, v, null);
          const q = unit(query);
          const expected = stored
            .map(({ id, v }) => ({ id, score: dot(q, v) }))
            .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
            .slice(0, k);
          const got = index.search(q, k);
          expect(got).toHaveLength(expected.length);
          got.forEach((h, i) => {
            expect(h.score).toBeCloseTo(expected[i]?.score ?? NaN, 4);
          });
        },
      ),
    );
  });
});
