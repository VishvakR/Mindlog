import type { Csr, PprOptions } from '@mindlog/index-graph';
import { personalizedPageRank } from '@mindlog/index-graph';

/** Piscina task: one PPR iteration off the event loop (CLAUDE.md 5). */
export function ppr(task: { graph: Csr; seed: Float64Array; options: PprOptions }): Float64Array {
  return personalizedPageRank(task.graph, task.seed, task.options);
}
