import type { Csr } from './csr.js';

export interface PprOptions {
  /** Probability of following an edge rather than jumping back to the seed (HippoRAG: 0.5). */
  readonly damping: number;
  readonly maxIterations: number;
  /** Stop once the L1 change of an iteration is below this. */
  readonly tolerance: number;
}

export const DEFAULT_PPR: PprOptions = { damping: 0.5, maxIterations: 30, tolerance: 1e-6 };

/**
 * Personalized PageRank by power iteration (PLAN 11.3):
 * `r ← (1 − d)·s + d·Pᵀr`, `P` the weight-normalised transition matrix of the
 * undirected graph; a node without edges returns its mass to the seed.
 * Returns all zeros when the seed has no positive weight.
 */
export function personalizedPageRank(
  graph: Csr,
  seed: Float64Array,
  options: PprOptions = DEFAULT_PPR,
): Float64Array {
  const n = graph.ids.length;
  const { offsets, targets, weights } = graph;
  let total = 0;
  for (let i = 0; i < n; i++) total += Math.max(0, seed[i] ?? 0);
  const s = new Float64Array(n);
  if (!(total > 0)) return s;
  for (let i = 0; i < n; i++) s[i] = Math.max(0, seed[i] ?? 0) / total;
  const strength = new Float64Array(n);
  for (let i = 0; i < n; i++)
    for (let e = offsets[i] as number; e < (offsets[i + 1] as number); e++)
      strength[i] = (strength[i] as number) + (weights[e] as number);
  const d = options.damping;
  let r = Float64Array.from(s);
  let next = new Float64Array(n);
  for (let iteration = 0; iteration < options.maxIterations; iteration++) {
    let dangling = 0;
    for (let i = 0; i < n; i++) next[i] = (1 - d) * (s[i] as number);
    for (let i = 0; i < n; i++) {
      const mass = r[i] as number;
      if (mass === 0) continue;
      const out = strength[i] as number;
      if (out === 0) {
        dangling += mass;
        continue;
      }
      const share = (d * mass) / out;
      for (let e = offsets[i] as number; e < (offsets[i + 1] as number); e++) {
        const t = targets[e] as number;
        next[t] = (next[t] as number) + share * (weights[e] as number);
      }
    }
    let delta = 0;
    for (let i = 0; i < n; i++) {
      next[i] = (next[i] as number) + d * dangling * (s[i] as number);
      delta += Math.abs((next[i] as number) - (r[i] as number));
    }
    [r, next] = [next, r];
    if (delta < options.tolerance) break;
  }
  return r;
}
