import type { AuthRecord, AuthStorage } from './auth-store.js';
import { AuthStore } from './auth-store.js';

export type RecordModel = Record<string, unknown> & { id: string };

export interface RecordQuery {
  readonly filter?: string;
  readonly sort?: string;
  readonly expand?: string;
  readonly fields?: string;
  readonly skipTotal?: boolean;
}

export interface ListResult<T = RecordModel> {
  readonly page: number;
  readonly perPage: number;
  readonly totalItems: number;
  readonly totalPages: number;
  readonly items: T[];
}

export interface RealtimeEvent<T = RecordModel> {
  readonly action: 'create' | 'update' | 'delete';
  readonly record: T;
}

export interface ClientOptions {
  /** Tenant for requests whose credential names none. */
  readonly tenant?: string;
  /** Persists the session (browsers: `localStorage`). */
  readonly storage?: AuthStorage;
}

/** A failed request: RFC 9457 problem details, with per-field messages when there are any. */
export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly fields: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

interface AuthResponse {
  readonly token: string;
  readonly refreshToken?: string;
  readonly record: AuthRecord;
}

type Listener = (e: RealtimeEvent) => void;
const MAX_BACKOFF_MS = 10_000;
const FULL_LIST_PAGE = 500;

export class MindlogClient {
  readonly authStore: AuthStore;
  readonly #base: string;
  readonly #tenant: string | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();
  #clientId = '';
  #abort: AbortController | undefined;
  #lastEventId = '';

  constructor(baseUrl: string, options: ClientOptions = {}) {
    this.#base = baseUrl.replace(/\/$/, '');
    this.#tenant = options.tenant;
    this.authStore = new AuthStore(options.storage);
  }

  collection(name: string): RecordService {
    return new RecordService(this, name);
  }

  #headers(
    extra: Record<string, string> = {},
    token = this.authStore.token,
  ): Record<string, string> {
    return {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(this.#tenant ? { 'x-mindlog-tenant': this.#tenant } : {}),
      ...extra,
    };
  }

  /** The full URL of an API path. */
  url(path: string): string {
    return `${this.#base}${path}`;
  }

  /** The headers that authenticate a request: `token`, else the session's. */
  authHeaders(token?: string): Record<string, string> {
    return this.#headers({}, token ?? this.authStore.token);
  }

  /** Calls the API; a `FormData` body is sent as multipart, anything else as JSON. */
  async send<T>(
    path: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<T> {
    const isForm = typeof FormData !== 'undefined' && init.body instanceof FormData;
    const hasJson = init.body !== undefined && !isForm;
    const res = await fetch(`${this.#base}${path}`, {
      method: init.method ?? 'GET',
      headers: this.#headers(hasJson ? { 'content-type': 'application/json' } : {}, init.token),
      ...(isForm
        ? { body: init.body as FormData }
        : hasJson
          ? { body: JSON.stringify(init.body) }
          : {}),
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const data = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
    if (!res.ok) {
      throw new ClientError(
        res.status,
        typeof data['detail'] === 'string' ? data['detail'] : `HTTP ${String(res.status)}`,
        typeof data['code'] === 'string' ? data['code'] : '',
        (data['fields'] ?? {}) as Record<string, string>,
      );
    }
    return data as T;
  }

  /** The URL of a record's file; pass a `token` from `getFileToken` when the record is not public. */
  fileUrl(
    record: { id: string; collectionName?: unknown },
    filename: string,
    options: { thumb?: string; token?: string; collection?: string } = {},
  ): string {
    const name =
      options.collection ??
      (typeof record.collectionName === 'string' ? record.collectionName : '');
    const q = new URLSearchParams();
    if (options.thumb) q.set('thumb', options.thumb);
    if (options.token) q.set('token', options.token);
    const query = q.toString();
    return `${this.#base}/api/files/${name}/${record.id}/${encodeURIComponent(filename)}${query ? `?${query}` : ''}`;
  }

  async getFileToken(): Promise<string> {
    return (await this.send<{ token: string }>('/api/files/token', { method: 'POST' })).token;
  }

  /** An agent's API key plus the user's token give a token that acts as the user. */
  async delegate(apiKey: string, userToken: string): Promise<string> {
    const r = await this.send<{ token: string }>('/api/auth/delegate', {
      method: 'POST',
      token: apiKey,
      body: { userToken },
    });
    return r.token;
  }

  /** Follows `collection/*` or `collection/id`; the returned function stops it. */
  async subscribe(topic: string, listener: Listener): Promise<() => Promise<void>> {
    let set = this.#listeners.get(topic);
    if (!set) this.#listeners.set(topic, (set = new Set()));
    set.add(listener);
    if (!this.#abort) await this.#connect();
    else if (this.#clientId) await this.#sendTopics();
    return async () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(topic);
      if (this.#listeners.size === 0) this.disconnect();
      else if (this.#clientId) await this.#sendTopics();
    };
  }

  /** Closes the realtime stream. */
  disconnect(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    this.#clientId = '';
  }

  #sendTopics(): Promise<void> {
    return this.send('/api/realtime', {
      method: 'POST',
      body: { clientId: this.#clientId, subscriptions: [...this.#listeners.keys()] },
    });
  }

  /** Opens the stream and resolves once the subscriptions are in place; reconnects by itself. */
  #connect(): Promise<void> {
    const abort = new AbortController();
    this.#abort = abort;
    return new Promise((resolve, reject) => {
      let first = true;
      const loop = async (): Promise<void> => {
        for (let attempt = 0; !abort.signal.aborted; attempt++) {
          try {
            await this.#read(abort, async () => {
              attempt = -1;
              await this.#sendTopics();
              if (first) resolve();
              first = false;
            });
          } catch (e) {
            if (first && e instanceof ClientError) {
              this.disconnect();
              reject(e);
              return;
            }
          }
          this.#clientId = '';
          await new Promise((r) =>
            setTimeout(r, Math.min(MAX_BACKOFF_MS, 200 * 2 ** Math.max(attempt, 0))),
          );
        }
      };
      void loop();
    });
  }

  async #read(abort: AbortController, connected: () => Promise<void>): Promise<void> {
    const res = await fetch(`${this.#base}/api/realtime`, {
      headers: {
        accept: 'text/event-stream',
        ...(this.#lastEventId ? { 'last-event-id': this.#lastEventId } : {}),
      },
      signal: abort.signal,
    });
    if (!res.ok || !res.body) throw new ClientError(res.status, 'realtime refused', '', {});
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += value;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split('\n')
            .find((l) => l.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        const [event, data, id] = [field('event'), field('data'), field('id')];
        if (event === undefined || data === undefined) continue;
        if (event === 'PB_CONNECT') {
          this.#clientId = (JSON.parse(data) as { clientId: string }).clientId;
          await connected();
          continue;
        }
        if (id) this.#lastEventId = id;
        for (const l of this.#listeners.get(event) ?? []) l(JSON.parse(data) as RealtimeEvent);
      }
    }
  }
}

const queryString = (q: Record<string, string | number | boolean | undefined>): string => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
  const s = params.toString();
  return s ? `?${s}` : '';
};

export class RecordService {
  readonly #path: string;

  constructor(
    private readonly client: MindlogClient,
    readonly name: string,
  ) {
    this.#path = `/api/collections/${encodeURIComponent(name)}`;
  }

  getList<T = RecordModel>(
    page = 1,
    perPage = 30,
    query: RecordQuery = {},
  ): Promise<ListResult<T>> {
    return this.client.send(`${this.#path}/records${queryString({ page, perPage, ...query })}`);
  }

  async getFullList<T = RecordModel>(query: RecordQuery = {}): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const list = await this.getList<T>(page, FULL_LIST_PAGE, { ...query, skipTotal: true });
      out.push(...list.items);
      if (list.items.length < FULL_LIST_PAGE) return out;
    }
  }

  getOne<T = RecordModel>(
    id: string,
    query: Pick<RecordQuery, 'expand' | 'fields'> = {},
  ): Promise<T> {
    return this.client.send(`${this.#path}/records/${encodeURIComponent(id)}${queryString(query)}`);
  }

  create<T = RecordModel>(body: Record<string, unknown> | FormData): Promise<T> {
    return this.client.send(`${this.#path}/records`, { method: 'POST', body });
  }

  update<T = RecordModel>(id: string, body: Record<string, unknown> | FormData): Promise<T> {
    return this.client.send(`${this.#path}/records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    });
  }

  delete(id: string): Promise<void> {
    return this.client.send(`${this.#path}/records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async #signedIn(r: Promise<AuthResponse>): Promise<AuthResponse> {
    const auth = await r;
    this.client.authStore.save(auth.token, auth.record, auth.refreshToken);
    return auth;
  }

  authWithPassword(identity: string, password: string): Promise<AuthResponse> {
    return this.#signedIn(
      this.client.send(`${this.#path}/auth-with-password`, {
        method: 'POST',
        body: { identity, password },
      }),
    );
  }

  /** Uses the stored refresh token when there is one, otherwise the current access token. */
  authRefresh(): Promise<AuthResponse> {
    const { refreshToken } = this.client.authStore;
    return this.#signedIn(
      this.client.send(`${this.#path}/auth-refresh`, {
        method: 'POST',
        body: refreshToken ? { refreshToken } : {},
      }),
    );
  }

  subscribe(id: string, listener: Listener): Promise<() => Promise<void>> {
    return this.client.subscribe(`${this.name}/${id}`, listener);
  }
}
