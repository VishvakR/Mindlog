import { ok } from '@mindlog/core';
import { communities, toCsr, walk } from '@mindlog/index-graph';
import type { Stage } from '../pipeline/stage.js';
import type { ScopeReads } from '../read/memory-reads.js';
import { MEMORY_NODE } from '../read/memory-reads.js';
import type { RecallTheme } from '../types.js';
import type { RecallDraft } from './recall-draft.js';
import { withList, withSignal } from './recall-draft.js';

export interface ThemeConfig {
  /** Most nodes of the sub-graph communities are found in. */
  readonly themeMaxNodes: number;
  /** Communities returned per broad query. */
  readonly themeCount: number;
  readonly pprMentionLimit: number;
  readonly retrieveK: number;
}

const SEED_HITS = 10;

/**
 * The `theme` retriever for broad queries (PLAN 12.4, ADR-0011): communities
 * of the 2-hop memory graph around the query's entities and best keyword and
 * vector hits, computed on demand until phase 8 stores theme memories. The
 * communities holding most seeds win; their memories rank by connectedness.
 */
export function themeStage(reads: ScopeReads, config: ThemeConfig): Stage<RecallDraft> {
  return {
    name: 'theme',
    async run(d) {
      if (d.route !== 'broad') return ok(d);
      const seeds = new Set<string>();
      for (const id of d.queryEntities) if (await reads.entity(id)) seeds.add(id);
      for (const name of ['keyword', 'vector'])
        for (const id of (d.lists.get(name) ?? []).slice(0, SEED_HITS)) seeds.add(MEMORY_NODE + id);
      if (seeds.size === 0) return ok({ ...d, lists: withList(d, 'theme', []) });
      const graph = toCsr(
        await walk(reads.memoryGraph(config.pprMentionLimit), [...seeds], {
          depth: 2,
          limit: config.themeMaxNodes,
        }),
      );
      const labels = communities(graph);
      const groups = new Map<number, { seeds: number; nodes: Array<[string, number]> }>();
      graph.ids.forEach((id, i) => {
        const label = labels[i] as number;
        const g = groups.get(label) ?? { seeds: 0, nodes: [] };
        let degree = 0;
        for (let e = graph.offsets[i] as number; e < (graph.offsets[i + 1] as number); e++)
          degree += graph.weights[e] as number;
        g.nodes.push([id, degree]);
        if (seeds.has(id)) g.seeds++;
        groups.set(label, g);
      });
      const byDegree = (a: [string, number], b: [string, number]) =>
        b[1] - a[1] || (a[0] < b[0] ? -1 : 1);
      const themes: RecallTheme[] = [...groups.values()]
        .map((g) => ({ ...g, memories: g.nodes.filter(([id]) => id.startsWith(MEMORY_NODE)) }))
        .filter((g) => g.memories.length >= 2)
        .sort((a, b) => b.seeds - a.seeds || b.memories.length - a.memories.length)
        .slice(0, config.themeCount)
        .map((g) => ({
          label: g.nodes
            .filter(([id]) => !id.startsWith(MEMORY_NODE))
            .sort(byDegree)
            .slice(0, 3)
            .map(([id]) => id.slice(id.indexOf(':') + 1))
            .join(', '),
          ids: g.memories.sort(byDegree).map(([id]) => id.slice(MEMORY_NODE.length)),
        }));
      const hits = themes
        .flatMap((t) => t.ids)
        .slice(0, config.retrieveK)
        .map((id, i, all) => ({ id, score: 1 - i / all.length }));
      return ok({
        ...d,
        themes,
        lists: withList(
          d,
          'theme',
          hits.map((h) => h.id),
        ),
        signals: withSignal(d.signals, hits, 'theme'),
      });
    },
  };
}
