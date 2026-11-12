import { distance, normalise } from './clusters.js';

export interface TwoMeans {
  readonly centroids: readonly [Float32Array, Float32Array];
  /** 0 or 1 per input vector. */
  readonly assign: Uint8Array;
  /** Mean distance of each side's vectors to its centroid. */
  readonly spread: readonly [number, number];
}

/** Runs `twoMeans`, inline or on a worker thread (the composition root decides). */
export type KmeansRunner = (vectors: readonly Float32Array[], seed: number) => Promise<TwoMeans>;

/** A small deterministic generator: the split must not depend on which node computes it. */
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function mean(vectors: readonly Float32Array[], pick: (i: number) => boolean, dims: number) {
  const sum = new Float32Array(dims);
  let n = 0;
  vectors.forEach((v, i) => {
    if (!pick(i)) return;
    n++;
    for (let d = 0; d < dims; d++) sum[d] = (sum[d] ?? 0) + (v[d] ?? 0);
  });
  return { centroid: normalise(sum), n };
}

/**
 * k-means with k = 2 over L2-normalised vectors (PLAN 8.5), cosine distance,
 * k-means++ seeding from `seed`, at most `iterations` rounds. Pure, so the
 * same input gives the same split on every node.
 */
export function twoMeans(
  vectors: readonly Float32Array[],
  seed: number,
  iterations = 25,
): TwoMeans {
  const dims = vectors[0]?.length ?? 0;
  const rand = lcg(seed);
  const first = vectors[Math.floor(rand() * vectors.length)] ?? new Float32Array(dims);
  // k-means++: the second centre is drawn in proportion to squared distance from the first.
  const weights = vectors.map((v) => distance(v, first) ** 2);
  const total = weights.reduce((a, b) => a + b, 0);
  let pick = rand() * total;
  let second = vectors.find((_, i) => (pick -= weights[i] ?? 0) <= 0) ?? first;
  if (total === 0) second = first;
  let centroids: [Float32Array, Float32Array] = [first.slice(), second.slice()];
  const assign = new Uint8Array(vectors.length);
  for (let round = 0; round < iterations; round++) {
    let changed = false;
    for (const [i, v] of vectors.entries()) {
      const side = distance(v, centroids[1]) < distance(v, centroids[0]) ? 1 : 0;
      if (assign[i] !== side) changed = true;
      assign[i] = side;
    }
    const a = mean(vectors, (i) => assign[i] === 0, dims);
    const b = mean(vectors, (i) => assign[i] === 1, dims);
    // An empty side keeps its centre, so the split never collapses to one cluster.
    centroids = [a.n > 0 ? a.centroid : centroids[0], b.n > 0 ? b.centroid : centroids[1]];
    if (!changed && round > 0) break;
  }
  const spread: [number, number] = [0, 0];
  const counts = [0, 0];
  vectors.forEach((v, i) => {
    const side = assign[i] === 1 ? 1 : 0;
    spread[side] += distance(v, centroids[side]);
    counts[side] = (counts[side] ?? 0) + 1;
  });
  return {
    centroids,
    assign,
    spread: [spread[0] / Math.max(1, counts[0] ?? 0), spread[1] / Math.max(1, counts[1] ?? 0)],
  };
}

/** The inline runner, for tests and nodes without a pool. */
export const inlineKmeans: KmeansRunner = (vectors, seed) =>
  Promise.resolve(twoMeans(vectors, seed));
