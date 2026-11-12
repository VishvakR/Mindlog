import type { TwoMeans } from '@mindlog/memory';
import { twoMeans } from '@mindlog/memory';

/** Piscina task: a semantic split's k-means off the event loop (CLAUDE.md 5). */
export function kmeans(task: { vectors: Float32Array[]; seed: number }): TwoMeans {
  return twoMeans(task.vectors, task.seed);
}
