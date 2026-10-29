/** Exact-match form of an entity name (PLAN 11.3): NFKC, lowercase, single spaces, no edge punctuation. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');
}

/** An entity's id within its scope: `type:normalized name` (ADR-0031), so equal names converge. */
export function entityId(type: string, name: string): string {
  return `${type.toLowerCase()}:${normalizeName(name)}`;
}

export interface Adjacency {
  readonly relation: string;
  /** The node at the other end. */
  readonly node: string;
  readonly direction: 'out' | 'in';
  readonly weight: number;
}

/** Edges of one node in both directions; the key layout belongs to the caller (ADR-0031). */
export interface GraphReader {
  neighbors(node: string): AsyncIterable<Adjacency>;
}

export interface WalkOptions {
  /** Hops from the seeds; at most 2 (PPR builds its sub-graph with this walk). */
  readonly depth: number;
  /** Most nodes to return, seeds included. */
  readonly limit: number;
}

export interface WalkResult {
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly depth: number }>;
  readonly edges: ReadonlyArray<{
    readonly src: string;
    readonly relation: string;
    readonly dst: string;
    readonly weight: number;
  }>;
  /** True when the node limit stopped the walk early. */
  readonly truncated: boolean;
}

const MAX_DEPTH = 2;

/** Breadth-first walk from the seeds, undirected, bounded by depth and node count. */
export async function walk(
  reader: GraphReader,
  seeds: readonly string[],
  options: WalkOptions,
): Promise<WalkResult> {
  const depth = Math.min(options.depth, MAX_DEPTH);
  const seen = new Map<string, number>();
  const edges = new Map<string, WalkResult['edges'][number]>();
  let frontier: string[] = [];
  for (const s of seeds) {
    if (seen.size >= options.limit)
      return { nodes: list(seen), edges: [...edges.values()], truncated: true };
    if (!seen.has(s)) {
      seen.set(s, 0);
      frontier.push(s);
    }
  }
  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      for await (const a of reader.neighbors(node)) {
        if (!seen.has(a.node)) {
          if (seen.size >= options.limit)
            return { nodes: list(seen), edges: [...edges.values()], truncated: true };
          seen.set(a.node, d);
          next.push(a.node);
        }
        const [src, dst] = a.direction === 'out' ? [node, a.node] : [a.node, node];
        edges.set(`${src}\u0000${a.relation}\u0000${dst}`, {
          src,
          relation: a.relation,
          dst,
          weight: a.weight,
        });
      }
    }
    frontier = next;
  }
  return { nodes: list(seen), edges: [...edges.values()], truncated: false };
}

function list(seen: Map<string, number>): WalkResult['nodes'] {
  return [...seen].map(([id, depth]) => ({ id, depth }));
}
