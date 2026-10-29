import { tokenize } from '@mindlog/index-text';

/** MMR trade-off between relevance and novelty (PLAN 12.4 stage 8). */
export const MMR_LAMBDA = 0.7;

export interface MmrCandidate {
  readonly id: string;
  readonly text: string;
  readonly score: number;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Similarity of two candidates: cosine of their stored (normalised) vectors,
 * or token Jaccard when either has none.
 */
export function similarity(
  vector: (id: string) => Float32Array | undefined,
): (a: MmrCandidate, b: MmrCandidate) => number {
  const tokens = new Map<string, Set<string>>();
  const vectors = new Map<string, Float32Array | undefined>();
  const vectorOf = (id: string) => {
    if (!vectors.has(id)) vectors.set(id, vector(id));
    return vectors.get(id);
  };
  const tokensOf = (c: MmrCandidate) => {
    let t = tokens.get(c.id);
    if (!t) tokens.set(c.id, (t = new Set(tokenize(c.text))));
    return t;
  };
  return (a, b) => {
    const va = vectorOf(a.id);
    const vb = vectorOf(b.id);
    return va && vb && va.length === vb.length ? cosine(va, vb) : jaccard(tokensOf(a), tokensOf(b));
  };
}

/**
 * Maximal Marginal Relevance: repeatedly takes the candidate maximising
 * `λ·score − (1 − λ)·max similarity to those taken`. Scores should be on a
 * 0..1 scale like the similarity. Returns all candidates in the new order.
 */
export function mmr<C extends MmrCandidate>(
  candidates: readonly C[],
  sim: (a: C, b: C) => number,
  lambda = MMR_LAMBDA,
): C[] {
  const left = [...candidates];
  const out: C[] = [];
  const maxSim = new Map<string, number>(left.map((c) => [c.id, 0]));
  while (left.length > 0) {
    let best = 0;
    let bestValue = -Infinity;
    left.forEach((c, i) => {
      const value = lambda * c.score - (1 - lambda) * (maxSim.get(c.id) ?? 0);
      if (value > bestValue) {
        best = i;
        bestValue = value;
      }
    });
    const [taken] = left.splice(best, 1) as [C];
    out.push(taken);
    for (const c of left) maxSim.set(c.id, Math.max(maxSim.get(c.id) ?? 0, sim(c, taken)));
  }
  return out;
}
