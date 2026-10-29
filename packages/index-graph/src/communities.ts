import type { Csr } from './csr.js';

/**
 * Label propagation (PLAN 12.6 ThemeBuilder stand-in): each node takes the
 * label with the largest edge weight among its neighbours, ties to the
 * smallest label, visiting nodes in index order until nothing changes.
 * Deterministic for a given graph. Returns one community label per node.
 */
export function communities(graph: Csr, maxRounds = 20): Int32Array {
  const n = graph.ids.length;
  const { offsets, targets, weights } = graph;
  const labels = Int32Array.from({ length: n }, (_, i) => i);
  const votes = new Map<number, number>();
  for (let round = 0; round < maxRounds; round++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      votes.clear();
      for (let e = offsets[i] as number; e < (offsets[i + 1] as number); e++) {
        const l = labels[targets[e] as number] as number;
        votes.set(l, (votes.get(l) ?? 0) + (weights[e] as number));
      }
      let best = labels[i] as number;
      let bestVotes = votes.get(best) ?? 0;
      for (const [l, v] of votes)
        if (v > bestVotes || (v === bestVotes && l < best)) {
          best = l;
          bestVotes = v;
        }
      if (best !== labels[i]) {
        labels[i] = best;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return labels;
}
