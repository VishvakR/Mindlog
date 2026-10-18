/** Typed client for the Mindlog HTTP API (packages/adapter-http). */

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
  clear(): void {
    try {
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = session.token();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
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
};
