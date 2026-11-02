import type { Csr } from './csr.js';

/** Symmetric weighted adjacency; `adj[i].get(i)` is the internal weight of an aggregated node. */
type Adj = Array<Map<number, number>>;

/**
 * One local-moving phase: each node in index order joins the neighbouring
 * community with the best modularity gain (ties to the smaller id) until no
 * node moves. Returns the community of each node, or undefined if none moved.
 */
function moveNodes(adj: Adj, resolution: number, maxSweeps: number): Int32Array | undefined {
  const n = adj.length;
  const k = adj.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const m2 = k.reduce((a, b) => a + b, 0);
  if (m2 === 0) return undefined;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const total = Float64Array.from(k);
  let movedAny = false;
  const links = new Map<number, number>();
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const own = community[i] as number;
      const ki = k[i] as number;
      total[own] = (total[own] as number) - ki;
      links.clear();
      links.set(own, 0);
      for (const [j, w] of adj[i] as Map<number, number>)
        if (j !== i) {
          const c = community[j] as number;
          links.set(c, (links.get(c) ?? 0) + w);
        }
      let best = own;
      let bestGain = -Infinity;
      for (const [c, w] of links) {
        const gain = w - (resolution * (total[c] as number) * ki) / m2;
        if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && c < best)) {
          best = c;
          bestGain = gain;
        }
      }
      total[best] = (total[best] as number) + ki;
      if (best !== own) {
        community[i] = best;
        moved = true;
        movedAny = true;
      }
    }
    if (!moved) break;
  }
  return movedAny ? community : undefined;
}

/** Renumbers labels 0..k-1 in order of first appearance. */
function compact(labels: Int32Array): Int32Array {
  const ids = new Map<number, number>();
  return labels.map((l) => {
    let id = ids.get(l);
    if (id === undefined) ids.set(l, (id = ids.size));
    return id;
  });
}

/**
 * Louvain communities (Blondel et al. 2008; ADR-0033 ThemeBuilder): local
 * moving, then the communities collapse into nodes, repeated while anything
 * moves. Deterministic for a given graph. Returns a community per node,
 * numbered from 0 in order of the nodes' first appearance.
 */
export function louvain(graph: Csr, resolution = 1, maxLevels = 10, maxSweeps = 50): Int32Array {
  const n = graph.ids.length;
  let adj: Adj = Array.from({ length: n }, (_, i) => {
    const m = new Map<number, number>();
    for (let e = graph.offsets[i] as number; e < (graph.offsets[i + 1] as number); e++)
      m.set(graph.targets[e] as number, graph.weights[e] as number);
    return m;
  });
  let membership = Int32Array.from({ length: n }, (_, i) => i);
  for (let level = 0; level < maxLevels; level++) {
    const moved = moveNodes(adj, resolution, maxSweeps);
    if (!moved) break;
    const labels = compact(moved);
    membership = membership.map((c) => labels[c] as number);
    const size = Math.max(...labels) + 1;
    const next: Adj = Array.from({ length: size }, () => new Map<number, number>());
    adj.forEach((m, i) => {
      const a = labels[i] as number;
      const row = next[a] as Map<number, number>;
      for (const [j, w] of m) {
        const b = labels[j] as number;
        row.set(b, (row.get(b) ?? 0) + w);
      }
    });
    adj = next;
  }
  return compact(membership);
}
