import type { CacheEntry } from '@mindlog/proto';
import { cosine, decodeVector } from './prompt.js';

/** A lookup as the evaluator sees it: the normalised prompt and its embedding when one was made. */
export interface CacheQuery {
  readonly prompt: string;
  readonly vector?: Float32Array;
}

/**
 * Confirms that a candidate entry answers the query (PLAN 13.9; GPTCache's
 * `SimilarityEvaluation`). Scores are 0..1 and compared with the threshold.
 */
export interface SimilarityEvaluator {
  readonly name: string;
  evaluate(query: CacheQuery, entry: CacheEntry): Promise<number>;
}

/** Exact normalised prompts score 1; otherwise the embeddings' cosine, or 0 without both. */
export function similarityOf(query: CacheQuery, entry: CacheEntry): number {
  if (query.prompt === entry.prompt) return 1;
  if (!query.vector || entry.vector.byteLength !== query.vector.length * 4) return 0;
  return cosine(query.vector, decodeVector(entry.vector));
}

/** The default evaluator: the same cosine that picked the candidate. */
export const cosineEvaluator: SimilarityEvaluator = {
  name: 'cosine',
  evaluate: (query, entry) => Promise.resolve(similarityOf(query, entry)),
};
