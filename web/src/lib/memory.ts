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
}

export interface RecallSignals {
  vector?: number;
  keyword?: number;
  entity?: number;
  fused: number;
  recency: number;
  importance: number;
  retention: number;
}

export interface RecallResult {
  items: Array<{ memory: MemoryView; score: number; signals: RecallSignals }>;
  context: string;
  tokens: number;
  degraded: boolean;
}

export interface GraphResult {
  nodes: Array<{ id: string; name: string; type: string; depth: number; mentions: number }>;
  edges: Array<{ src: string; relation: string; dst: string; weight: number }>;
  memories: string[];
  truncated: boolean;
}

export interface HistoryEntry {
  version: string;
  atMs: number;
  memory: MemoryView;
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
