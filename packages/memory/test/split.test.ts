import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  baseUser,
  cluster,
  clusterIdOf,
  clusterUser,
  normalise,
  rankClusters,
  twoMeans,
} from '../src/index.js';

const v = (...xs: number[]) => normalise(Float32Array.from(xs));

describe('cluster names', () => {
  test('round-trip, and cluster 0 is the scope itself', () => {
    expect(clusterUser('ann', 0)).toBe('ann');
    expect(clusterUser('ann', 3)).toBe('ann\u0000c3');
    expect(baseUser('ann\u0000c3')).toBe('ann');
    expect(clusterIdOf('ann\u0000c3')).toBe(3);
    expect(clusterIdOf('ann')).toBe(0);
  });
});

describe('twoMeans', () => {
  test('separates two well-apart groups, the same way every time', () => {
    const left = Array.from({ length: 20 }, (_, i) => v(1, 0.05 * (i % 3), 0));
    const right = Array.from({ length: 20 }, (_, i) => v(0, 0.05 * (i % 3), 1));
    const vectors = [...left, ...right];
    const a = twoMeans(vectors, 7);
    const b = twoMeans(vectors, 7);
    expect([...a.assign]).toEqual([...b.assign]);
    const sides = new Set([...a.assign.slice(0, 20)]);
    expect(sides.size).toBe(1);
    expect(a.assign[0]).not.toBe(a.assign[20]);
    expect(a.spread[0]).toBeLessThan(0.05);
  });

  test('never leaves a side without a centre', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 }),
          {
            minLength: 1,
            maxLength: 30,
          },
        ),
        fc.integer({ min: 1, max: 1000 }),
        (rows, seed) => {
          const r = twoMeans(
            rows.map((x) => v(...x)),
            seed,
          );
          expect(r.centroids).toHaveLength(2);
          expect(r.assign).toHaveLength(rows.length);
          for (const s of r.spread) expect(Number.isFinite(s)).toBe(true);
        },
      ),
    );
  });
});

test('rankClusters puts the nearest centroid first', () => {
  const clusters = [
    cluster(0, v(1, 0, 0), 0),
    cluster(1, v(0, 1, 0), 0),
    cluster(2, v(0, 0, 1), 0),
  ];
  expect(rankClusters(v(0.1, 0.9, 0.2), clusters)).toEqual([1, 2, 0]);
});
