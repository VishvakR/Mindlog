/** Typed client for the Mindlog HTTP API (packages/adapter-http). */
import type {
  BranchDiff,
  BranchView,
  ChangeEvent,
  ConflictView,
  GraphResult,
  HistoryEntry,
  JobView,
  LifecycleView,
  MemoryScope,
  MemoryView,
  MergePolicy,
  MergeResult,
  RecallResult,
  RecipeName,
} from '@/lib/memory';
import { parseSse } from '@/lib/memory';

export type KeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'json';
export type Encoding = 'utf8' | 'base64';

export type KeyValue =
  | { type: 'string'; value: string }
  | { type: 'hash'; value: { field: string; value: string }[] }
  | { type: 'list'; value: string[] }
  | { type: 'set'; value: string[] }
  | { type: 'zset'; value: { member: string; score: number }[] }
  | { type: 'json'; value: unknown };

export interface KeySummary {
  key: string;
  encoding: Encoding;
  type: KeyType;
  ttlMs: number | null;
}

export type KeyDetail = KeyValue & {
  key: string;
  encoding: Encoding;
  ttlMs: number | null;
  length: number;
  truncated: boolean;
};

export interface Superuser {
  email: string;
  created: string;
  updated: string;
  /** Set on an account limited to one tenant; absent for a superuser. */
  role?: string;
  tenant?: string;
}

export interface Quotas {
  storageBytes?: number;
  keys?: number;
  memories?: number;
  writeQps?: number;
  recallQps?: number;
  modelSecondsPerHour?: number;
  connections?: number;
}

export interface TenantInfo {
  name: string;
  status: 'active' | 'deleting';
  created: string;
  quotas: Quotas;
  auditRetentionDays: number;
}

export interface TenantKey {
  id: string;
  tenant: string;
  user?: string;
  name: string;
  role: string;
  scopes?: string[];
  expiresAt?: number;
  created: string;
}

export interface AuditEntry {
  id: string;
  tenant: string;
  principal: string;
  actor: string;
  action: string;
  resource: string;
  ok: boolean;
  detail: string;
  atMs: number;
}

export interface LogEntry {
  atMs: number;
  level: 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  fields: Record<string, unknown>;
}

/** RFC 9457 problem details, as every API error is sent. */
export interface Problem {
  title: string;
  status: number;
  detail: string;
  code: string;
  fields?: Record<string, string>;
}

export class ApiError extends Error {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail || problem.title);
    this.problem = problem;
  }
}

const TOKEN_KEY = 'mindlog.token';
const TENANT_KEY = 'mindlog.tenant';

/** The bearer token, kept per browser; storage can be unavailable (private mode). */
export const session = {
  token(): string | null {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  save(token: string): void {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // the session then lasts until reload
    }
  },
  /** The tenant a member is limited to; null for a superuser. */
  tenant(): string | null {
    try {
      return localStorage.getItem(TENANT_KEY);
    } catch {
      return null;
    }
  },
  saveTenant(tenant: string | undefined): void {
    try {
      if (tenant) localStorage.setItem(TENANT_KEY, tenant);
      else localStorage.removeItem(TENANT_KEY);
    } catch {
      // the dashboard then treats the session as unrestricted and the server still refuses
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TENANT_KEY);
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // nothing stored
    }
  },
};

/** Called when the server rejects the token, so the app can return to login. */
let onUnauthorized = (): void => undefined;
export const setUnauthorizedHandler = (fn: () => void): void => {
  onUnauthorized = fn;
};

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const token = session.token();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401 && token) {
    session.clear();
    onUnauthorized();
  }
  if (!res.ok) {
    const problem = (await res.json().catch(() => undefined)) as Problem | undefined;
    throw new ApiError(
      problem ?? {
        title: res.statusText,
        status: res.status,
        detail: res.statusText,
        code: 'INTERNAL',
      },
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export interface ClusterNode {
  id: string;
  address: string;
  zone: string;
  state: string;
  binaryVersion: number;
  ranges: number;
  leaders: number;
  usedBytes: number;
}

export interface ClusterRange {
  id: string;
  start: string;
  end: string;
  epoch: string;
  replicas: { replicaId: string; nodeId: string; role: string }[];
}

export interface ClusterOperator {
  id: string;
  rangeId: string;
  scheduler: string;
  step: number;
  steps: string[];
  explanation: string;
  status: string;
  createdMs: number;
}

export interface ClusterOverview {
  clusterVersion: number;
  nodes: ClusterNode[];
  ranges: ClusterRange[];
  operators: ClusterOperator[];
  recent: ClusterOperator[];
}

export type ClusterAction =
  | { action: 'drain-node' | 'undrain-node' | 'remove-node'; nodeId: string }
  | { action: 'transfer-leader'; rangeId: string; replicaId: string }
  | { action: 'split'; rangeId: string };

const keyPath = (key: string, encoding: Encoding = 'utf8') =>
  `/kv/keys/${encodeURIComponent(key)}${encoding === 'base64' ? '?encoding=base64' : ''}`;

export interface ScanParams {
  cursor: string;
  match?: string;
  type?: KeyType;
  count?: number;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; superuser: Superuser }>('POST', '/superusers/auth-with-password', {
      email,
      password,
    }),
  superuserExists: () => request<{ exists: boolean }>('GET', '/superusers/exists'),
  me: () => request<Superuser>('GET', '/superusers/me'),
  tenants: () => request<{ tenants: TenantInfo[] }>('GET', '/tenants'),
  tenantCreate: (name: string) => request<TenantInfo>('POST', '/tenants', { name }),
  tenantSetQuotas: (tenant: string, quotas: Quotas) =>
    request<TenantInfo>('PUT', `/tenants/${encodeURIComponent(tenant)}/quotas`, quotas),
  tenantUsage: (tenant: string) =>
    request<{ bytes: number; keys: number; memories: number }>(
      'GET',
      `/tenants/${encodeURIComponent(tenant)}/usage`,
    ),
  tenantKeys: (tenant: string) =>
    request<{ keys: TenantKey[] }>('GET', `/tenants/${encodeURIComponent(tenant)}/keys`),
  tenantCreateKey: (tenant: string, input: { name: string; role: string }) =>
    request<TenantKey & { key: string }>(
      'POST',
      `/tenants/${encodeURIComponent(tenant)}/keys`,
      input,
    ),
  tenantRevokeKey: (tenant: string, id: string) =>
    request<undefined>(
      'DELETE',
      `/tenants/${encodeURIComponent(tenant)}/keys/${encodeURIComponent(id)}`,
    ),
  tenantMembers: (tenant: string) =>
    request<{ members: Superuser[] }>('GET', `/tenants/${encodeURIComponent(tenant)}/members`),
  tenantSaveMember: (tenant: string, input: { email: string; password: string; role: string }) =>
    request<Superuser>('PUT', `/tenants/${encodeURIComponent(tenant)}/members`, input),
  tenantRemoveMember: (tenant: string, email: string) =>
    request<undefined>(
      'DELETE',
      `/tenants/${encodeURIComponent(tenant)}/members/${encodeURIComponent(email)}`,
    ),
  audit: (tenant: string, cursor?: string) =>
    request<{ items: AuditEntry[]; cursor?: string }>(
      'GET',
      `/tenants/${encodeURIComponent(tenant)}/audit?limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
      }`,
    ),
  logs: () => request<{ entries: LogEntry[] }>('GET', '/admin/logs'),
  overview: () => request<Record<string, unknown>>('GET', '/admin/overview'),
  settings: () => request<Record<string, unknown>>('GET', '/admin/settings'),
  cluster: () => request<ClusterOverview>('GET', '/cluster/overview'),
  clusterAction: (action: ClusterAction) =>
    request<{ message: string }>('POST', '/cluster/actions', action),
  scan: (p: ScanParams) => {
    const q = new URLSearchParams({ cursor: p.cursor, count: String(p.count ?? 200) });
    if (p.match) q.set('match', p.match);
    if (p.type) q.set('type', p.type);
    return request<{ cursor: string; keys: KeySummary[] }>('GET', `/kv/keys?${q.toString()}`);
  },
  read: (key: string, encoding?: Encoding) => request<KeyDetail>('GET', keyPath(key, encoding)),
  write: (key: string, value: KeyValue & { ttlMs?: number | null; encoding?: Encoding }) =>
    request<void>('PUT', keyPath(key), value),
  remove: (key: string, encoding?: Encoding) => request<void>('DELETE', keyPath(key, encoding)),
  setTtl: (key: string, ttlMs: number | null) =>
    request<void>('PUT', `/kv/keys/${encodeURIComponent(key)}/ttl`, { ttlMs }),
  memoryScopes: (tenant: string) =>
    request<{ users: string[] }>('POST', '/memory/scopes', { tenant }),
  memoryList: (tenant: string, scope: MemoryScope, after?: string, kind?: string) =>
    request<{ memories: MemoryView[]; next?: string }>('POST', '/memory/list', {
      tenant,
      scope,
      limit: 50,
      ...(after ? { after } : {}),
      ...(kind ? { kind } : {}),
      includeForgotten: true,
    }),
  memoryHistory: (tenant: string, scope: MemoryScope, id: string) =>
    request<HistoryEntry[]>('POST', '/memory/history', { tenant, scope, id }),
  memoryForget: (tenant: string, scope: MemoryScope, id: string) =>
    request<{ count: number }>('POST', '/memory/forget', {
      tenant,
      scope,
      ids: [id],
      reason: 'forgotten from the dashboard',
    }),
  memoryRecall: (
    tenant: string,
    scope: MemoryScope,
    query: string,
    options: {
      k: number;
      tokenBudget: number;
      inherit: boolean;
      recipe: RecipeName;
      includeCold?: boolean;
    },
  ) =>
    request<RecallResult>('POST', '/memory/recall', {
      tenant,
      scope,
      query,
      ...options,
      explain: true,
    }),
  memoryGraph: (tenant: string, scope: MemoryScope, entity: string, depth: number) =>
    request<GraphResult>('POST', '/memory/graph', { tenant, scope, entity, depth }),
  /** The scope as it was at `timeMs` (ASOF), up to 200 memories. */
  memoryAsOf: (tenant: string, scope: MemoryScope, timeMs: number) =>
    request<{ memories: MemoryView[]; next?: string }>('POST', '/memory/list', {
      tenant,
      scope,
      limit: 200,
      asOf: { time: Math.floor(timeMs) },
    }),
  memoryConflicts: (tenant: string, scope: MemoryScope, all: boolean) =>
    request<{ conflicts: ConflictView[]; next?: string }>('POST', '/memory/conflicts', {
      tenant,
      scope,
      status: all ? 'all' : 'open',
      limit: 100,
    }),
  memoryResolve: (
    tenant: string,
    scope: MemoryScope,
    id: string,
    keep: 'a' | 'b' | 'both',
    validFrom?: string,
  ) =>
    request<{ ids: string[] }>('POST', '/memory/resolve', {
      tenant,
      scope,
      id,
      keep,
      ...(validFrom ? { validFrom } : {}),
    }),
  memoryTrust: (tenant: string, scope: MemoryScope, id: string, trust: string) =>
    request<{ count: number }>('POST', '/memory/trust', {
      tenant,
      scope,
      ids: [id],
      trust,
      reason: 'reviewed in the dashboard',
    }),
  memoryBranches: (tenant: string, scope: MemoryScope) =>
    request<BranchView[]>('POST', '/memory/branches', { tenant, scope }),
  memoryDiff: (tenant: string, scope: MemoryScope, name: string) =>
    request<BranchDiff>('POST', '/memory/diff', { tenant, scope, name }),
  memoryMerge: (tenant: string, scope: MemoryScope, name: string, policy: MergePolicy) =>
    request<MergeResult>('POST', '/memory/merge', { tenant, scope, name, policy }),
  memoryDrop: (tenant: string, scope: MemoryScope, name: string) =>
    request<{ count: number }>('POST', '/memory/drop', { tenant, scope, name }),
  memoryPin: (tenant: string, scope: MemoryScope, id: string, pinned: boolean) =>
    request<{ count: number }>('POST', '/memory/pin', { tenant, scope, ids: [id], pinned }),
  memoryJobs: (tenant: string, scope: MemoryScope, state?: JobView['state']) =>
    request<{ jobs: JobView[]; lifecycle: LifecycleView; next?: string }>('POST', '/memory/jobs', {
      tenant,
      scope,
      limit: 200,
      ...(state ? { state } : {}),
    }),
  memoryConsolidate: (tenant: string, scope: MemoryScope, workers?: string[]) =>
    request<{ enqueued: string[] }>('POST', '/memory/consolidate', {
      tenant,
      scope,
      ...(workers ? { workers } : {}),
    }),
  memoryExport: (tenant: string, scope: MemoryScope) =>
    request<{ data: string; bytes: number }>('POST', '/memory/export', { tenant, scope }),
  memoryImport: (
    tenant: string,
    scope: MemoryScope,
    data: string,
    format: 'mcube' | 'cogx',
    name: string,
  ) =>
    request<{ imported: number; skipped: number }>('POST', '/memory/import', {
      tenant,
      scope,
      data,
      format,
      name,
    }),
};

/**
 * Follows a scope's changes from `/api/realtime` (SSE over fetch, so the bearer
 * token goes in a header). Resumes after `from`; resolves when `signal` aborts
 * or the stream ends.
 */
export async function followChanges(
  tenant: string,
  user: string,
  from: string | undefined,
  on: (event: ChangeEvent | { type: 'resync' }) => void,
  signal: AbortSignal,
  opened?: () => void,
): Promise<void> {
  const token = session.token();
  const query = new URLSearchParams({ tenant, user, ...(from ? { from } : {}) });
  const res = await fetch(`/api/realtime?${query.toString()}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream refused (${String(res.status)})`);
  opened?.();
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseSse(buffer + value);
    buffer = parsed.rest;
    for (const e of parsed.events)
      on(e.event === 'resync' ? { type: 'resync' } : (JSON.parse(e.data) as ChangeEvent));
  }
}
