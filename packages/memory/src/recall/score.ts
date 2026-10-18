/** RRF constant (PLAN 12.4). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion: `Σ_r w_r / (k + rank_r(d))`, ranks from 1, weights
 * default to 1 (PLAN 12.4 stage 4).
 */
export function rrf(
  lists: ReadonlyMap<string, readonly string[]>,
  weights: Readonly<Record<string, number>>,
  k = RRF_K,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const [retriever, ids] of lists) {
    const w = weights[retriever] ?? 1;
    ids.forEach((id, i) => {
      fused.set(id, (fused.get(id) ?? 0) + w / (k + i + 1));
    });
  }
  return fused;
}

/** Generative Agents recency: 0.995^hours since last access. */
export const recency = (hours: number): number => 0.995 ** Math.max(0, hours);

/** MemoryBank retention: e^(−t/S), t in days, S the memory's strength in days. */
export const retention = (days: number, strength: number): number =>
  Math.exp(-Math.max(0, days) / Math.max(strength, 1e-6));

export interface ScoreInputs {
  /** Fused relevance normalised to 0..1. */
  readonly relevance: number;
  readonly recency: number;
  readonly importance: number;
  readonly retention: number;
  readonly trust: string;
}

/** Defaults of PLAN 12.5. */
export const WEIGHTS = { relevance: 0.6, recency: 0.15, importance: 0.15, retention: 0.1 } as const;
const VERIFIED_BONUS = 0.05;

/** The final score (PLAN 12.5); quarantined memories are filtered before scoring. */
export function finalScore(s: ScoreInputs): number {
  return (
    WEIGHTS.relevance * s.relevance +
    WEIGHTS.recency * s.recency +
    WEIGHTS.importance * s.importance +
    WEIGHTS.retention * s.retention +
    (s.trust === 'verified' ? VERIFIED_BONUS : 0)
  );
}
