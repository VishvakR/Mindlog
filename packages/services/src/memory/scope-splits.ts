import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type {
  CubeParts,
  GraphView,
  HistoryEntry,
  MemoryView,
  RecallItem,
  RecallOutput,
  RouteResult,
} from '@mindlog/memory';
import { pack, packCube, traceText } from '@mindlog/memory';

/** Runs one operation on one cluster of a split scope (validated, routed, retried). */
export type ClusterCall = <T>(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cluster: number,
) => Promise<Result<T, MindlogError>>;

type Input = Readonly<Record<string, unknown>> & {
  readonly scope: { readonly user: string };
};
type Written = { ids: string[]; count: number };

/** Clusters a recall searches when it has a query vector (PLAN 8.5: top-2). */
const FANOUT = 2;
/** RRF's constant (ADR-0011). */
const RRF_K = 60;
const LAYOUT_TTL_MS = 2_000;
const MAX_CACHED = 10_000;
/** Most memories a taint cascade follows across clusters. */
const MAX_CASCADE = 10_000;

/** Operations a split scope refuses: branches and the semantic cache are per range (ADR-0039). */
const REFUSED = new Set([
  'branchCreate',
  'branchDiff',
  'branchMerge',
  'branchDrop',
  'cacheGet',
  'cacheSet',
  'cacheDel',
]);
const FAN_WRITES = new Set(['trust', 'pin']);
const TRUST_ORDER: Readonly<Record<string, number>> = { quarantined: 0, normal: 1, verified: 2 };

const notFound = (e: MindlogError) => e.code === 'NOT_FOUND';

/** A `c<cluster>:<inner>` cursor of a paged read across clusters. */
function splitCursor(
  after: unknown,
  clusters: readonly number[],
): { index: number; inner?: string } {
  if (typeof after !== 'string') return { index: 0 };
  const at = after.indexOf(':');
  const cluster = after.startsWith('c') && at > 0 ? Number(after.slice(1, at)) : NaN;
  const index = clusters.indexOf(cluster);
  if (index < 0) return { index: 0 };
  const inner = after.slice(at + 1);
  return inner ? { index, inner } : { index };
}

/**
 * A split scope as callers see it (ADR-0039): one scope. Writes go to the
 * cluster nearest their text; recall searches the nearest clusters and fuses
 * their rankings; every other operation addresses all clusters and merges
 * the answers. An unsplit scope never reaches this class.
 */
export class ScopeSplits {
  readonly #layouts = new Map<string, { at: number; clusters: number[] }>();

  constructor(private readonly clock: Clock) {}

  /** The scope's cluster ids (with 0), cached briefly; one id means unsplit. */
  async clusters(
    tenant: string,
    user: string,
    read: () => Promise<Result<{ clusters: number[] }, MindlogError>>,
  ): Promise<Result<number[], MindlogError>> {
    const key = `${tenant}\u0000${user}`;
    const now = Number(this.clock.now());
    const hit = this.#layouts.get(key);
    if (hit && now - hit.at < LAYOUT_TTL_MS) return ok(hit.clusters);
    const got = await read();
    if (!got.ok) return got;
    const clusters = got.value.clusters.length > 0 ? got.value.clusters : [0];
    this.#layouts.delete(key);
    this.#layouts.set(key, { at: now, clusters });
    if (this.#layouts.size > MAX_CACHED) {
      const oldest = this.#layouts.keys().next();
      if (oldest.done !== true) this.#layouts.delete(oldest.value);
    }
    return ok(clusters);
  }

  /** Drops a cached layout, after this node changed it. */
  forget(tenant: string, user: string): void {
    this.#layouts.delete(`${tenant}\u0000${user}`);
  }

  async run(
    name: string,
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<unknown, MindlogError>> {
    if (REFUSED.has(name))
      return err(mindlogError('INVALID_ARGUMENT', `${name} is not available on a split scope`));
    const at = await this.#asOf(input, call);
    if (!at.ok) return at;
    const i = at.value;
    switch (name) {
      case 'remember':
        return this.#remember(i, clusters, call);
      case 'recall':
        return this.#recall(i, clusters, call);
      case 'get':
        return this.#first(name, i, clusters, call);
      case 'getMany': {
        const all = await this.#all<{ memories: MemoryView[] }>(name, i, clusters, call);
        if (!all.ok) return all;
        const byId = new Map(all.value.flatMap((r) => r.memories).map((m) => [m.id, m]));
        return ok({ memories: [...byId.values()] });
      }
      case 'resolve':
        return this.#first(name, i, clusters, call);
      case 'list':
        return this.#paged(i, clusters, call, 'list', 'memories');
      case 'conflicts':
        return this.#paged(i, clusters, call, 'conflicts', 'conflicts');
      case 'forget':
        return this.#forget(i, clusters, call);
      case 'history':
        return this.#history(i, clusters, call);
      case 'graph':
        return this.#graph(i, clusters, call);
      case 'jobs':
        return this.#jobs(i, clusters, call);
      case 'export':
        return this.#export(i, clusters, call);
      case 'consolidate': {
        const all = await this.#all<{ enqueued: string[] }>(name, i, clusters, call);
        return all.ok ? ok({ enqueued: all.value.flatMap((r) => r.enqueued) }) : all;
      }
      default:
        if (FAN_WRITES.has(name)) {
          const all = await this.#all<Written>(name, i, clusters, call);
          return all.ok ? ok(union(all.value)) : all;
        }
        // import, branches, scopes and anything else: the root scope, cluster 0.
        return call(name, i, 0);
    }
  }

  /** `ASOF index` names a log position of one range; clusters share time, so send the time instead. */
  async #asOf(input: Input, call: ClusterCall): Promise<Result<Input, MindlogError>> {
    const asOf = input.asOf as { index?: string } | undefined;
    if (asOf?.index === undefined) return ok(input);
    const time = await call<{ time: number }>(
      'asOfTime',
      { scope: input.scope, index: asOf.index },
      0,
    );
    return time.ok ? ok({ ...input, asOf: { time: time.value.time } }) : time;
  }

  async #all<T>(
    name: string,
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<T[], MindlogError>> {
    const results = await Promise.all(clusters.map((c) => call<T>(name, input, c)));
    const out: T[] = [];
    for (const r of results) {
      if (r.ok) out.push(r.value);
      else if (!notFound(r.error)) return r;
    }
    return ok(out);
  }

  async #first(
    name: string,
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<unknown, MindlogError>> {
    let last: Result<unknown, MindlogError> = ok(undefined);
    for (const c of clusters) {
      const r = await call(name, input, c);
      if (r.ok && r.value !== undefined && r.value !== null) return r;
      if (!r.ok && !notFound(r.error)) return r;
      last = r;
    }
    return last;
  }

  async #remember(
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<unknown, MindlogError>> {
    const parents = input.derivedFrom as readonly string[] | undefined;
    if (parents && parents.length > 0) {
      // Derived memories are no more trusted than their inputs (PLAN 13.4): writing them where the
      // least trusted parent lives lets the commit see that parent, so its trust is inherited.
      let best: { cluster: number; rank: number } | undefined;
      for (const id of parents)
        for (const c of clusters) {
          const got = await call<MemoryView | undefined>('get', { scope: input.scope, id }, c);
          if (!got.ok || !got.value) continue;
          const rank = TRUST_ORDER[got.value.trust] ?? 1;
          if (!best || rank < best.rank) best = { cluster: c, rank };
          break;
        }
      if (best) return call('remember', input, best.cluster);
    }
    const trace = input.toolTrace as Parameters<typeof traceText>[0] | undefined;
    const text = typeof input.content === 'string' ? input.content : trace ? traceText(trace) : '';
    const routed = await call<RouteResult>(
      'route',
      { scope: input.scope, text, kind: 'passage' },
      0,
    );
    // Without an embedding the root takes the write; a later rebalance can move it.
    const target = routed.ok && !routed.value.degraded ? (routed.value.clusters[0] ?? 0) : 0;
    return call('remember', input, target);
  }

  async #recall(
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<unknown, MindlogError>> {
    const query = String(input.query);
    const routed = await call<RouteResult>(
      'route',
      { scope: input.scope, text: query, kind: 'query' },
      0,
    );
    const ranked = routed.ok ? routed.value.clusters : [...clusters];
    const degraded = !routed.ok || routed.value.degraded;
    const chosen = degraded ? [...clusters] : ranked.slice(0, FANOUT);
    const results = await Promise.all(chosen.map((c) => call<RecallOutput>('recall', input, c)));
    const outs: RecallOutput[] = [];
    for (const r of results) {
      if (r.ok) outs.push(r.value);
      else if (!notFound(r.error)) return r;
    }
    const [first] = outs;
    if (!first) return err(mindlogError('UNAVAILABLE', 'no cluster of the scope answered'));
    return ok(fuse(outs, typeof input.k === 'number' ? input.k : undefined, degraded));
  }

  async #paged(
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
    name: 'list' | 'conflicts',
    field: 'memories' | 'conflicts',
  ): Promise<Result<unknown, MindlogError>> {
    const limit = typeof input.limit === 'number' ? input.limit : 50;
    const { index, inner } = splitCursor(input.after, clusters);
    const items: unknown[] = [];
    const seen = new Set<string>();
    for (let at = index; at < clusters.length; at++) {
      const cluster = clusters[at] ?? 0;
      const { after: _after, ...rest } = input;
      const page = await call<Record<string, unknown> & { next?: string }>(
        name,
        {
          ...rest,
          limit: limit - items.length,
          ...(at === index && inner ? { after: inner } : {}),
        },
        cluster,
      );
      if (!page.ok) return page;
      // A memory being moved is briefly in both clusters (copied, not yet marked); show it once.
      for (const item of (page.value[field] as Array<{ id?: string }> | undefined) ?? [])
        if (item.id === undefined || !seen.has(item.id)) {
          if (item.id !== undefined) seen.add(item.id);
          items.push(item);
        }
      if (page.value.next)
        return ok({ [field]: items, next: `c${String(cluster)}:${page.value.next}` });
      if (items.length >= limit) {
        const nextCluster = clusters[at + 1];
        return ok(
          nextCluster === undefined
            ? { [field]: items }
            : { [field]: items, next: `c${String(nextCluster)}:` },
        );
      }
    }
    return ok({ [field]: items });
  }

  /** Forgets across clusters; a taint cascade follows derived memories into other clusters. */
  async #forget(
    input: Input,
    clusters: readonly number[],
    call: ClusterCall,
  ): Promise<Result<unknown, MindlogError>> {
    const first = await this.#all<Written>('forget', input, clusters, call);
    if (!first.ok) return first;
    const done = union(first.value);
    if (typeof input.source !== 'string') return ok(done);
    const forgotten = new Set(done.ids);
    let frontier = [...done.ids];
    while (frontier.length > 0 && forgotten.size < MAX_CASCADE) {
      const children = await this.#all<string[]>(
        'derived',
        { scope: input.scope, ids: frontier },
        clusters,
        call,
      );
      if (!children.ok) return children;
      const next = [...new Set(children.value.flat())].filter((id) => !forgotten.has(id));
      if (next.length === 0) break;
      const reason = typeof input.reason === 'string' ? { reason: input.reason } : {};
      const more = await this.#all<Written>(
        'forget',
        { scope: input.scope, ids: next, ...reason },
        clusters,
        call,
      );
      if (!more.ok) return more;
      frontier = union(more.value).ids.filter((id) => !forgotten.has(id));
      for (const id of frontier) forgotten.add(id);
    }
    return ok({ ids: [...forgotten], count: forgotten.size });
  }

  async #history(input: Input, clusters: readonly number[], call: ClusterCall) {
    const all = await this.#all<HistoryEntry[]>('history', input, clusters, call);
    if (!all.ok) return all;
    const seen = new Set<string>();
    const entries = all.value
      .flat()
      .sort((a, b) => b.atMs - a.atMs || b.revision - a.revision)
      // A moved memory's copy repeats the revision it left with; keep one.
      .filter((e) => {
        const key = `${String(e.revision)}:${e.memory.text}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    return ok(entries);
  }

  async #graph(input: Input, clusters: readonly number[], call: ClusterCall) {
    const all = await this.#all<GraphView>('graph', input, clusters, call);
    if (!all.ok) return all;
    const nodes = new Map<string, GraphView['nodes'][number]>();
    const edges = new Map<string, GraphView['edges'][number]>();
    const memories = new Set<string>();
    for (const g of all.value) {
      for (const n of g.nodes) {
        const had = nodes.get(n.id);
        nodes.set(
          n.id,
          had
            ? { ...had, depth: Math.min(had.depth, n.depth), mentions: had.mentions + n.mentions }
            : n,
        );
      }
      for (const e of g.edges) {
        const key = `${e.src}\u0000${e.relation}\u0000${e.dst}`;
        const had = edges.get(key);
        edges.set(key, had ? { ...had, weight: had.weight + e.weight } : e);
      }
      for (const m of g.memories) memories.add(m);
    }
    return ok({
      nodes: [...nodes.values()],
      edges: [...edges.values()],
      memories: [...memories],
      truncated: all.value.some((g) => g.truncated),
    });
  }

  async #jobs(input: Input, clusters: readonly number[], call: ClusterCall) {
    type Jobs = { jobs: unknown[]; lifecycle: Record<string, unknown>; next?: string };
    const all = await this.#all<Jobs>('jobs', input, clusters, call);
    if (!all.ok) return all;
    const [root] = all.value;
    if (!root) return err(mindlogError('NOT_FOUND', 'no cluster of the scope answered'));
    const sum = (field: string) =>
      all.value.reduce(
        (n, j) => n + (typeof j.lifecycle[field] === 'number' ? j.lifecycle[field] : 0),
        0,
      );
    return ok({
      jobs: all.value.flatMap((j) => j.jobs),
      lifecycle: {
        ...root.lifecycle,
        hot: sum('hot'),
        cold: sum('cold'),
        writesSinceSleep: sum('writesSinceSleep'),
        writesSinceEvolve: sum('writesSinceEvolve'),
        clusters: clusters.length,
      },
    });
  }

  async #export(input: Input, clusters: readonly number[], call: ClusterCall) {
    const all = await this.#all<CubeParts & { asOfVersion: string }>(
      'exportParts',
      input,
      clusters,
      call,
    );
    if (!all.ok) return all;
    const [root] = all.value;
    if (!root) return err(mindlogError('NOT_FOUND', 'no cluster of the scope answered'));
    const entities = new Map<string, CubeParts['entities'][number]>();
    const edges = new Map<string, CubeParts['edges'][number]>();
    for (const p of all.value) {
      for (const e of p.entities) {
        const had = entities.get(e.id);
        entities.set(e.id, had ? { ...had, mentions: had.mentions + e.mentions } : e);
      }
      for (const e of p.edges) {
        const key = `${e.src}\u0000${e.relation}\u0000${e.dst}`;
        const had = edges.get(key);
        edges.set(key, had ? { ...had, weight: had.weight + e.weight } : e);
      }
    }
    const cube = packCube({
      ...root,
      scope: { tenant: root.scope.tenant, user: input.scope.user },
      asOfVersion: BigInt(root.asOfVersion),
      memories: all.value.flatMap((p) => p.memories),
      entities: [...entities.values()],
      edges: [...edges.values()],
    });
    return ok({ data: Buffer.from(cube).toString('base64'), bytes: cube.length });
  }
}

function union(results: readonly Written[]): Written {
  const ids = [...new Set(results.flatMap((r) => r.ids))];
  return { ids, count: results.reduce((n, r) => n + r.count, 0) };
}

/** Reciprocal rank fusion of the clusters' rankings, then packing again within the budget. */
function fuse(
  outs: readonly RecallOutput[],
  k: number | undefined,
  degraded: boolean,
): RecallOutput {
  const fused = new Map<string, { item: RecallItem; score: number }>();
  for (const out of outs)
    out.items.forEach((item, rank) => {
      const had = fused.get(item.memory.id);
      const add = 1 / (RRF_K + rank + 1);
      fused.set(item.memory.id, { item: had?.item ?? item, score: (had?.score ?? 0) + add });
    });
  const limit = k ?? Math.max(...outs.map((o) => o.items.length));
  const top = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const first = outs[0] as RecallOutput;
  const packed = pack(
    top.map(({ item, score }) => ({
      id: item.memory.id,
      text: item.memory.text,
      kind: item.memory.kind,
      score,
    })),
    first.budget,
  );
  return {
    ...first,
    items: top.map(({ item, score }) => ({ ...item, score })),
    context: packed.context,
    tokens: packed.tokens,
    budget: packed.budget,
    groups: packed.groups,
    dropped: packed.dropped,
    compressed: packed.compressed,
    degraded: degraded || outs.some((o) => o.degraded),
  };
}
