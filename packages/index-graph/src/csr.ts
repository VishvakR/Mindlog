import type { WalkResult } from './graph.js';

/**
 * An undirected weighted graph in compressed sparse rows: node `i`'s
 * neighbours are `targets[offsets[i] .. offsets[i + 1])`. Plain typed arrays,
 * so it can be transferred to a worker thread.
 */
export interface Csr {
  readonly ids: readonly string[];
  readonly offsets: Int32Array;
  readonly targets: Int32Array;
  readonly weights: Float64Array;
}

/** The undirected graph of a walk; parallel edges between two nodes add their weights. */
export function toCsr(walked: Pick<WalkResult, 'nodes' | 'edges'>): Csr {
  const ids = walked.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = ids.map(() => new Map<number, number>());
  for (const e of walked.edges) {
    const a = index.get(e.src);
    const b = index.get(e.dst);
    if (a === undefined || b === undefined || a === b || !(e.weight > 0)) continue;
    const na = adjacency[a] as Map<number, number>;
    const nb = adjacency[b] as Map<number, number>;
    na.set(b, (na.get(b) ?? 0) + e.weight);
    nb.set(a, (nb.get(a) ?? 0) + e.weight);
  }
  const offsets = new Int32Array(ids.length + 1);
  adjacency.forEach((m, i) => (offsets[i + 1] = (offsets[i] as number) + m.size));
  const targets = new Int32Array(offsets[ids.length] as number);
  const weights = new Float64Array(targets.length);
  adjacency.forEach((m, i) => {
    let at = offsets[i] as number;
    // Sorted neighbours keep every derived computation deterministic.
    for (const [t, w] of [...m].sort((x, y) => x[0] - y[0])) {
      targets[at] = t;
      weights[at++] = w;
    }
  });
  return { ids, offsets, targets, weights };
}
