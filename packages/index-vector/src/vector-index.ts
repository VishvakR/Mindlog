export interface VectorMatch {
  readonly id: string;
  /** Cosine similarity, higher is closer. */
  readonly score: number;
}

/**
 * Vector index port (PLAN 4.3, 11.1). Vectors must be L2-normalised. `filter`
 * runs during the search, so up to `k` matching results come back however
 * many others are excluded (Qdrant-style filtering, ADR-0008).
 */
export interface VectorIndex<M> {
  readonly dims: number;
  readonly size: number;
  upsert(id: string, vector: Float32Array, meta: M): void;
  /** Whether `id` was present. */
  remove(id: string): boolean;
  /** The `k` nearest vectors, nearest first; equal scores ordered by id. */
  search(query: Float32Array, k: number, filter?: (meta: M, id: string) => boolean): VectorMatch[];
}
