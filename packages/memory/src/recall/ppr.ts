import { ok } from '@mindlog/core';
import type { Csr, PprOptions } from '@mindlog/index-graph';
import { personalizedPageRank, toCsr, walk } from '@mindlog/index-graph';
import type { Stage } from '../pipeline/stage.js';
import type { ScopeReads } from '../read/memory-reads.js';
import { MEMORY_NODE } from '../read/memory-reads.js';
import type { RecallDraft } from './recall-draft.js';
import { withList, withSignal } from './recall-draft.js';

/** Runs the PPR iteration, inline or on a worker thread (CLAUDE.md 5). */
export type PprRunner = (
  graph: Csr,
  seed: Float64Array,
  options: PprOptions,
) => Promise<Float64Array>;

export const inlinePpr: PprRunner = (graph, seed, options) =>
  Promise.resolve(personalizedPageRank(graph, seed, options));

export interface PprConfig extends PprOptions {
  /** Most nodes of the sub-graph PPR runs on (PLAN 11.3: 5,000). */
  readonly pprMaxNodes: number;
  /** Memories read per entity when building it. */
  readonly pprMentionLimit: number;
  /** Query entities kept as seeds (HippoRAG `linking_top_k`). */
  readonly pprEntitySeeds: number;
  /** Weight of dense-retrieval memory seeds (HippoRAG `passage_node_weight`). */
  readonly pprMemorySeedWeight: number;
}

/** Min-max normalisation; a single value or equal values map to 1. */
export function minMax(scores: ReadonlyMap<string, number>): Map<string, number> {
  const values = [...scores.values()];
  const lo = Math.min(...values);
  const range = Math.max(...values) - lo;
  return new Map([...scores].map(([id, s]) => [id, range > 0 ? (s - lo) / range : 1]));
}

/** Seed weights by node (PLAN 11.3): IDF-like query entities and down-weighted vector hits. */
export async function pprSeeds(
  d: RecallDraft,
  reads: ScopeReads,
  config: PprConfig,
): Promise<Map<string, number>> {
  const entities: Array<[string, number]> = [];
  for (const id of d.queryEntities) {
    const e = await reads.entity(id);
    if (e && e.mentionCount > 0) entities.push([id, 1 / e.mentionCount]);
  }
  entities.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const seeds = new Map(entities.slice(0, config.pprEntitySeeds));
  const dense = new Map<string, number>();
  for (const id of d.lists.get('vector') ?? []) {
    const s = d.signals.get(id)?.vector;
    if (s !== undefined) dense.set(id, s);
  }
  if (dense.size > 0)
    for (const [id, s] of minMax(dense))
      if (s > 0) seeds.set(MEMORY_NODE + id, s * config.pprMemorySeedWeight);
  return seeds;
}

/**
 * The `ppr` retriever (PLAN 11.3, ADR-0011): Personalized PageRank over the
 * 2-hop memory graph around the seeds; memories are ranked by their own PPR
 * mass. Without a positive seed it returns nothing.
 */
export function pprStage(
  reads: ScopeReads,
  runner: PprRunner,
  config: PprConfig & { readonly retrieveK: number },
): Stage<RecallDraft> {
  return {
    name: 'ppr',
    async run(d) {
      const seeds = await pprSeeds(d, reads, config);
      if (seeds.size === 0) return ok({ ...d, lists: withList(d, 'ppr', []) });
      const walked = await walk(reads.memoryGraph(config.pprMentionLimit), [...seeds.keys()], {
        depth: 2,
        limit: config.pprMaxNodes,
      });
      const graph = toCsr(walked);
      const seed = Float64Array.from(graph.ids, (id) => seeds.get(id) ?? 0);
      const scores = await runner(graph, seed, config);
      const hits = graph.ids
        .map((id, i) => ({ id, score: scores[i] ?? 0 }))
        .filter((h) => h.score > 0 && h.id.startsWith(MEMORY_NODE))
        .map((h) => ({ id: h.id.slice(MEMORY_NODE.length), score: h.score }))
        .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
        .slice(0, config.retrieveK);
      return ok({
        ...d,
        lists: withList(
          d,
          'ppr',
          hits.map((h) => h.id),
        ),
        signals: withSignal(d.signals, hits, 'ppr'),
      });
    },
  };
}
