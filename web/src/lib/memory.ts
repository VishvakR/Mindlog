// Types of the /api/memory routes and pure helpers for the memory pages.

export interface MemoryScope {
  user: string;
  agent?: string;
  session?: string;
}

export interface MemoryView {
  id: string;
  user: string;
  agent?: string;
  session?: string;
  kind: string;
  text: string;
  entities: string[];
  links: Array<{ to: string; relation: string; weight: number }>;
  source: { type: string; ref?: string; principal: string };
  trust: string;
  importance: number;
  tags: string[];
  createdAtMs: number;
  expiredAtMs?: number;
  forgetReason?: string;
  validFromMs?: number;
  validToMs?: number;
  /** Lifecycle (ADR-0033). */
  tier: 'hot' | 'cold';
  pinned: boolean;
  version: number;
  strength: number;
  recallCount: number;
  lastRecalledAtMs?: number;
  meta?: Record<string, unknown>;
}

export interface RecallSignals {
  vector?: number;
  keyword?: number;
  entity?: number;
  ppr?: number;
  theme?: number;
  rerank?: number;
  fused: number;
  recency: number;
  importance: number;
  retention: number;
}

/** Named recall configurations (ADR-0011), in increasing order of work. */
export const RECIPES = [
  { name: 'rag', label: 'Plain RAG', hint: 'Vector search, ranked by similarity only' },
  { name: 'vector', label: 'Vector', hint: 'Vector search with recency, importance and retention' },
  { name: 'hybrid', label: 'Hybrid', hint: 'Vector, keyword and entity retrievers fused' },
  { name: 'hybrid_ppr', label: 'Hybrid + graph', hint: 'Hybrid plus Personalized PageRank' },
  { name: 'full', label: 'Full', hint: 'Hybrid, graph, themes, cross-encoder rerank and MMR' },
] as const;
export type RecipeName = (typeof RECIPES)[number]['name'];

export interface RecallItem {
  memory: MemoryView;
  score: number;
  signals: RecallSignals;
}

export interface RecallResult {
  items: RecallItem[];
  context: string;
  tokens: number;
  budget: number;
  groups: Array<{ name: string; ids: string[] }>;
  dropped: string[];
  compressed: string[];
  recipe: RecipeName;
  route: 'specific' | 'multihop' | 'broad';
  degraded: boolean;
  explain?: {
    lists: Record<string, string[]>;
    themes: Array<{ label: string; ids: string[] }>;
  };
}

const RETRIEVER_ORDER = ['vector', 'keyword', 'entity', 'ppr', 'theme'];

/**
 * Each retriever's ranked list for display, top `limit`, with the memory text
 * when the memory is among the returned items (other ids show as ids).
 */
export function retrieverColumns(
  r: Pick<RecallResult, 'items' | 'explain'>,
  limit = 10,
): Array<{
  name: string;
  total: number;
  rows: Array<{ id: string; text?: string; rank: number }>;
}> {
  const text = new Map(r.items.map((i) => [i.memory.id, i.memory.text]));
  return Object.entries(r.explain?.lists ?? {})
    .sort(([a], [b]) => RETRIEVER_ORDER.indexOf(a) - RETRIEVER_ORDER.indexOf(b))
    .map(([name, ids]) => ({
      name,
      total: ids.length,
      rows: ids.slice(0, limit).map((id, i) => {
        const t = text.get(id);
        return t === undefined ? { id, rank: i + 1 } : { id, text: t, rank: i + 1 };
      }),
    }));
}

/** Which per-retriever signals any item carries, in display order. */
export function presentSignals(items: readonly RecallItem[]): Array<keyof RecallSignals> {
  const raw: Array<keyof RecallSignals> = ['vector', 'keyword', 'entity', 'ppr', 'theme', 'rerank'];
  return raw.filter((key) => items.some((i) => i.signals[key] !== undefined));
}

export interface GraphResult {
  nodes: Array<{ id: string; name: string; type: string; depth: number; mentions: number }>;
  edges: Array<{ src: string; relation: string; dst: string; weight: number }>;
  memories: string[];
  truncated: boolean;
}

export interface HistoryEntry {
  /** MVCC version; '' when only the kept copy of an older revision remains. */
  version: string;
  revision: number;
  atMs: number;
  memory: MemoryView;
}

/** A durable job (PLAN 12.7). */
export interface JobView {
  id: string;
  kind: string;
  state: 'queued' | 'leased' | 'dead';
  attempts: number;
  deferrals: number;
  runAtMs: number;
  leaseUntilMs?: number;
  error?: string;
  createdAtMs: number;
  why?: string;
}

/** A scope's lifecycle counts (ADR-0033). */
export interface LifecycleView {
  hot: number;
  cold: number;
  writesSinceSleep: number;
  writesSinceEvolve: number;
  graphSize: number;
  graphSizeAtTheme: number;
  embedModel: string;
  reembed: boolean;
  lastWriteMs?: number;
  lastRunMs: Record<string, number>;
  tickAtMs?: number;
  coldTier: boolean;
}

export const WORKERS = [
  'sleep',
  'evolve',
  'dedup',
  'themes',
  'entities',
  'forget',
  'reembed',
  'cache',
] as const;

/** What changed between two versions of a memory, as `field: before → after` lines. */
export function versionChanges(before: MemoryView, after: MemoryView): string[] {
  const out: string[] = [];
  const show = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  const fields: Array<keyof MemoryView> = [
    'text',
    'trust',
    'tier',
    'pinned',
    'importance',
    'tags',
    'validToMs',
  ];
  for (const f of fields)
    if (show(before[f]) !== show(after[f]))
      out.push(`${f}: ${show(before[f]) ?? '—'} → ${show(after[f]) ?? '—'}`);
  const metaBefore = before.meta ?? {};
  const metaAfter = after.meta ?? {};
  for (const k of new Set([...Object.keys(metaBefore), ...Object.keys(metaAfter)]))
    if (show(metaBefore[k]) !== show(metaAfter[k]))
      out.push(`meta.${k}: ${show(metaBefore[k]) ?? '—'} → ${show(metaAfter[k]) ?? '—'}`);
  if (!before.expiredAtMs && after.expiredAtMs)
    out.push(`forgotten${after.forgetReason ? `: ${after.forgetReason}` : ''}`);
  const linksBefore = new Set(before.links.map((l) => `${l.relation}:${l.to}`));
  for (const l of after.links)
    if (!linksBefore.has(`${l.relation}:${l.to}`)) out.push(`link + ${l.relation} → ${l.to}`);
  return out;
}

export const MEMORY_KINDS = [
  'episodic',
  'semantic',
  'procedural',
  'working',
  'theme',
  'tool_trace',
] as const;

/** `user[/agent[/session]]`, as RESP takes it. */
export function parseScope(text: string): MemoryScope {
  const [user = '', agent, session] = text.split('/').map((s) => s.trim());
  return { user, ...(agent ? { agent } : {}), ...(session ? { session } : {}) };
}

export function formatScope(scope: MemoryScope): string {
  const parts = [scope.user, scope.agent, scope.session].filter(Boolean);
  return parts.length === 0 ? '(tenant-wide)' : parts.join('/');
}

/**
 * Positions for a neighbourhood graph: the entity in the centre, each depth on
 * its own ring, the nodes of a ring evenly spaced (deterministic, no physics).
 */
export function radialLayout(
  nodes: ReadonlyArray<{ id: string; depth: number }>,
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const cx = width / 2;
  const cy = height / 2;
  const deepest = Math.max(1, ...nodes.map((n) => n.depth));
  const step = (Math.min(width, height) / 2 - 24) / deepest;
  const rings = new Map<number, string[]>();
  for (const n of nodes) rings.set(n.depth, [...(rings.get(n.depth) ?? []), n.id]);
  const out = new Map<string, { x: number; y: number }>();
  for (const [depth, ids] of rings) {
    ids.forEach((id, i) => {
      if (depth === 0) {
        out.set(id, { x: cx, y: cy });
        return;
      }
      // Offset odd rings by half a slot so labels of neighbouring rings do not line up.
      const angle = (2 * Math.PI * (i + (depth % 2) * 0.5)) / ids.length - Math.PI / 2;
      out.set(id, {
        x: Math.round((cx + depth * step * Math.cos(angle)) * 100) / 100,
        y: Math.round((cy + depth * step * Math.sin(angle)) * 100) / 100,
      });
    });
  }
  return out;
}

/** A tenant and scope as the memory pages hold them. */
export interface ScopeValue {
  tenant: string;
  scope: MemoryScope;
  /** What was typed, kept so partial input like `alice/` is not rewritten. */
  text: string;
}

export const initialScope = (): ScopeValue => ({
  tenant: 'default',
  scope: { user: '' },
  text: '',
});

/** A contradiction between an older memory (a) and a newer one (b) (ADR-0015). */
export interface ConflictView {
  id: string;
  a?: MemoryView;
  b?: MemoryView;
  scores: [number, number];
  status: 'open' | 'resolved';
  policy: string;
  origin: string;
  detectedAtMs: number;
  keep?: 'a' | 'b' | 'both';
  resolvedBy?: string;
  resolvedAtMs?: number;
}

/** A memory branch (ADR-0013). */
export interface BranchView {
  name: string;
  status: 'open' | 'merged' | 'dropped';
  forkIndex: string;
  forkAtMs: number;
  createdBy: string;
  writes: number;
  closedAtMs?: number;
}

export interface BranchDiff {
  added: MemoryView[];
  forgotten: MemoryView[];
  changed: MemoryView[];
}

export const MERGE_POLICIES = [
  { name: 'raise', hint: 'Add contradicting facts quarantined and open conflicts' },
  { name: 'prefer_branch', hint: 'Branch facts replace the main facts they contradict' },
  { name: 'prefer_main', hint: 'Leave contradicting branch facts out' },
  { name: 'abort', hint: 'Merge nothing if anything contradicts main' },
] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number]['name'];

export interface MergeResult {
  merged: boolean;
  added: string[];
  rejected: string[];
  conflicts: Array<{ a: string; b: string; scores: [number, number]; resolved: boolean }>;
}

/** One change of a scope from `/api/realtime` (PLAN 13.5). */
export interface ChangeEvent {
  cursor: string;
  type: string;
  tenant: string;
  user: string;
  branch?: string;
  ids: string[];
  principal: string;
  atMs: number;
}

/**
 * Splits Server-Sent Events text into complete events and the unfinished
 * rest: `{ event, id, data }` per block (comments are skipped).
 */
export function parseSse(text: string): {
  events: Array<{ event: string; id?: string; data: string }>;
  rest: string;
} {
  const blocks = text.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events = [];
  for (const block of blocks) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const at = line.indexOf(':');
      const field = at < 0 ? line : line.slice(0, at);
      const value = at < 0 ? '' : line.slice(at + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length > 0) events.push({ event, ...(id ? { id } : {}), data: data.join('\n') });
  }
  return { events, rest };
}
