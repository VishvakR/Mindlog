import { ClientError } from './client.js';
import type { MindlogClient } from './client.js';

/** A memory as the API returns it (PLAN 12). */
export interface Memory {
  readonly id: string;
  readonly user: string;
  readonly kind: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly trust: string;
  readonly createdAtMs: number;
  readonly expiredAtMs?: number;
}

export interface RecallHit {
  readonly memory: Memory;
  readonly score: number;
}

export interface Recalled {
  readonly items: readonly RecallHit[];
  /** The packed context to put in a prompt. */
  readonly context: string;
  readonly degraded: boolean;
}

/** A change to a scope's memory (PLAN 13.5); ids only, so a follower fetches what it needs. */
export interface MemoryChange {
  readonly type: string;
  readonly cursor: string;
  readonly ids: readonly string[];
}

export interface RememberOptions {
  readonly kind?: string;
  readonly tags?: readonly string[];
  readonly meta?: Readonly<Record<string, unknown>>;
  /** The same id applies once; generated when absent. */
  readonly requestId?: string;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['UNAVAILABLE', 'BUSY', 'RATE_LIMITED', 'NOT_LEADER']);
const ATTEMPTS = 5;

/** A failure the next attempt may not have: the network, or the server asking to retry. */
export function isRetryable(e: unknown): boolean {
  if (e instanceof ClientError)
    return RETRYABLE_STATUS.has(e.status) || RETRYABLE_CODES.has(e.code);
  return e instanceof TypeError; // fetch's network failure
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One user scope's memory (PLAN 15.5). Calls are retried on network failures
 * and on the server's retryable answers; writes carry a request id, so a
 * retry never applies twice.
 */
export class MemoryApi {
  constructor(
    private readonly client: MindlogClient,
    readonly user: string,
    /** An API key; without it the client's session token is used. */
    private readonly token?: string,
  ) {}

  async #call<T>(op: string, body: Record<string, unknown>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.client.send<T>(`/api/memory/${op}`, {
          method: 'POST',
          body: { scope: { user: this.user }, ...body },
          ...(this.token ? { token: this.token } : {}),
        });
      } catch (e) {
        if (attempt >= ATTEMPTS || !isRetryable(e)) throw e;
        await pause(100 * 2 ** attempt);
      }
    }
  }

  remember(
    content: string,
    options: RememberOptions = {},
  ): Promise<{ ids: string[]; memories: Memory[]; degraded: boolean }> {
    const { requestId = crypto.randomUUID(), ...rest } = options;
    return this.#call('remember', { content, requestId, ...rest });
  }

  recall(query: string, options: { k?: number; recipe?: string; tokenBudget?: number } = {}) {
    return this.#call<Recalled>('recall', { query, ...options });
  }

  get(id: string): Promise<Memory | null> {
    return this.#call('get', { id });
  }

  async getMany(ids: readonly string[]): Promise<Memory[]> {
    const out: Memory[] = [];
    for (let at = 0; at < ids.length; at += 100)
      out.push(
        ...(await this.#call<{ memories: Memory[] }>('getMany', { ids: ids.slice(at, at + 100) }))
          .memories,
      );
    return out;
  }

  list(options: { limit?: number; after?: string } = {}) {
    return this.#call<{ memories: Memory[]; next?: string }>('list', options);
  }

  forget(ids: readonly string[], options: { reason?: string; requestId?: string } = {}) {
    const { requestId = crypto.randomUUID(), reason } = options;
    return this.#call<{ ids: string[]; count: number }>('forget', {
      ids,
      requestId,
      ...(reason ? { reason } : {}),
    });
  }

  /**
   * Follows the scope's changes over SSE until `signal` aborts, resuming from
   * the last cursor after a dropped connection. A `resync` change means the
   * server no longer holds that cursor: re-read the scope, then keep going.
   * `onState` hears whether the stream is connected.
   */
  async follow(
    onChange: (change: MemoryChange) => void | Promise<void>,
    options: { signal: AbortSignal; from?: string; onState?: (connected: boolean) => void },
  ): Promise<void> {
    let cursor = options.from ?? '';
    const stopped = (): boolean => options.signal.aborted;
    for (let attempt = 0; !stopped(); attempt++) {
      try {
        const q = new URLSearchParams({ user: this.user });
        const res = await fetch(this.client.url(`/api/realtime?${q.toString()}`), {
          headers: {
            accept: 'text/event-stream',
            ...this.client.authHeaders(this.token),
            ...(cursor ? { 'last-event-id': cursor } : {}),
          },
          signal: options.signal,
        });
        if (!res.ok || !res.body)
          throw new ClientError(res.status, `HTTP ${String(res.status)}`, '', {});
        options.onState?.(true);
        attempt = 0;
        for await (const event of sse(res.body)) {
          if (event.event === 'resync') await onChange({ type: 'resync', cursor: '', ids: [] });
          else if (event.data) {
            const data = JSON.parse(event.data) as { ids?: string[] };
            cursor = event.id || cursor;
            await onChange({ type: event.event, cursor, ids: data.ids ?? [] });
          }
        }
      } catch (e) {
        if (stopped()) return;
        if (e instanceof ClientError && !isRetryable(e) && e.status !== 0) throw e;
      }
      options.onState?.(false);
      await pause(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
}

/** Server-sent events of a response body. */
async function* sse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id: string; event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let current = { id: '', event: 'message', data: '' };
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      if (line === '') {
        if (current.data || current.event !== 'message') yield current;
        current = { id: '', event: 'message', data: '' };
      } else if (!line.startsWith(':')) {
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'id') current.id = value;
        else if (field === 'event') current.event = value;
        else if (field === 'data') current.data += current.data ? `\n${value}` : value;
      }
    }
  }
}
