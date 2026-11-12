import { DatabaseSync } from 'node:sqlite';
import type { MindlogClient } from './client.js';
import type { Memory, MemoryChange, RememberOptions } from './memory.js';
import { MemoryApi, isRetryable } from './memory.js';

/** The same tables the Python SDK's replica uses (ADR-0040), so either can open the other's file. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  user TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL,
  pending INTEGER NOT NULL DEFAULT 0, vector BLOB, PRIMARY KEY (user, id));
CREATE TABLE IF NOT EXISTS queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, user TEXT NOT NULL, op TEXT NOT NULL,
  body TEXT NOT NULL, local_id TEXT);
CREATE TABLE IF NOT EXISTS cursors (user TEXT PRIMARY KEY, cursor TEXT NOT NULL);`;

export interface ReplicaOptions {
  /** The SQLite file; `:memory:` keeps nothing across restarts. */
  readonly path: string;
  /** User scopes to keep a copy of. */
  readonly users: readonly string[];
  /** An API key; without it the client's session token is used. */
  readonly apiKey?: string;
  /** Embeds texts for local vector search; without it local recall is keyword only. */
  readonly embed?: (texts: string[]) => Promise<Float32Array[]>;
  /** Told when a queued write is refused for good (a 4xx), so it is not retried. */
  readonly onRejected?: (op: string, error: unknown) => void;
}

export interface LocalHit {
  readonly id: string;
  readonly text: string;
  readonly kind: string;
  readonly score: number;
  /** Written while offline and not yet sent. */
  readonly pending: boolean;
}

interface Row {
  id: string;
  kind: string;
  text: string;
  tags: string;
  created_at: number;
  pending: number;
  vector: Uint8Array | null;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** BM25 over the given rows (k1 1.2, b 0.75), the same scoring the server's keyword retriever uses. */
function bm25(rows: readonly Row[], query: string): Map<string, number> {
  const terms = [...new Set(words(query))];
  const docs = rows.map((r) => words(r.text));
  const avg = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
  const out = new Map<string, number>();
  for (const term of terms) {
    const df = docs.filter((d) => d.includes(term)).length;
    if (df === 0) continue;
    const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
    docs.forEach((d, i) => {
      const tf = d.filter((w) => w === term).length;
      if (tf === 0) return;
      const id = rows[i]?.id ?? '';
      const s = (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.length) / avg));
      out.set(id, (out.get(id) ?? 0) + s);
    });
  }
  return out;
}

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
};

const asVector = (bytes: Uint8Array) =>
  new Float32Array(bytes.slice().buffer, 0, Math.floor(bytes.length / 4));

/**
 * An embedded replica (PLAN 13.10, ADR-0040): a local SQLite copy of some
 * user scopes that answers reads even while the server is unreachable.
 * It subscribes to each scope's changes before reading the scope, so nothing
 * is missed, and applies changes in order. Writes go to the server; while it
 * cannot be reached they wait in a queue with stable request ids and are
 * readable locally, then are replayed in order (each applies once).
 * Node only: it uses `node:sqlite`.
 */
export class EmbeddedReplica {
  readonly #db: DatabaseSync;
  readonly #apis = new Map<string, MemoryApi>();
  readonly #abort = new AbortController();
  #chain: Promise<unknown> = Promise.resolve();
  #connected = new Set<string>();

  private constructor(
    client: MindlogClient,
    private readonly options: ReplicaOptions,
  ) {
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(SCHEMA);
    for (const user of options.users)
      this.#apis.set(user, new MemoryApi(client, user, options.apiKey));
  }

  /** Opens the replica and starts following its scopes. */
  static open(client: MindlogClient, options: ReplicaOptions): EmbeddedReplica {
    const replica = new EmbeddedReplica(client, options);
    for (const user of options.users) replica.#follow(user);
    return replica;
  }

  /** Whether every scope's change stream is connected. */
  get online(): boolean {
    return this.#connected.size === this.#apis.size;
  }

  /** Runs `work` after everything queued before it: changes, syncs and flushes never interleave. */
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#chain.then(work, work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #api(user: string): MemoryApi {
    const api = this.#apis.get(user);
    if (!api) throw new RangeError(`the replica does not follow ${user}`);
    return api;
  }

  #follow(user: string): void {
    const stored = this.#db.prepare('SELECT cursor FROM cursors WHERE user = ?').get(user) as
      { cursor: string } | undefined;
    let first = stored === undefined;
    void this.#api(user)
      .follow((change) => this.#serial(() => this.#apply(user, change)), {
        signal: this.#abort.signal,
        ...(stored ? { from: stored.cursor } : {}),
        onState: (connected) => {
          if (!connected) {
            this.#connected.delete(user);
            return;
          }
          this.#connected.add(user);
          void this.#serial(async () => {
            await this.#flush(user);
            // A failed read is tried again while the stream stays up; a reconnect starts over.
            for (let attempt = 0; first && this.#connected.has(user); attempt++) {
              try {
                await this.#snapshot(user);
                first = false;
              } catch {
                await new Promise((r) => setTimeout(r, Math.min(5_000, 200 * 2 ** attempt)));
              }
            }
          });
        },
      })
      .catch(() => undefined);
  }

  async #apply(user: string, change: MemoryChange): Promise<void> {
    if (change.type === 'resync') {
      await this.#snapshot(user);
      return;
    }
    if (change.type === 'memory.forgotten') {
      const del = this.#db.prepare('DELETE FROM memories WHERE user = ? AND id = ?');
      for (const id of change.ids) del.run(user, id);
    } else if (change.type === 'memory.added' || change.type === 'memory.evolved') {
      await this.#store(user, await this.#api(user).getMany(change.ids));
    }
    if (change.cursor)
      this.#db
        .prepare(
          'INSERT INTO cursors (user, cursor) VALUES (?, ?) ON CONFLICT(user) DO UPDATE SET cursor = excluded.cursor',
        )
        .run(user, change.cursor);
  }

  /** Reads the whole scope again; written-offline rows stay until their write is replayed. */
  async #snapshot(user: string): Promise<void> {
    const all: Memory[] = [];
    let after: string | undefined;
    do {
      const page = await this.#api(user).list({ limit: 200, ...(after ? { after } : {}) });
      all.push(...page.memories);
      after = page.next;
    } while (after);
    this.#db.prepare('DELETE FROM memories WHERE user = ? AND pending = 0').run(user);
    await this.#store(user, all);
  }

  async #store(user: string, memories: readonly Memory[]): Promise<void> {
    const live = memories.filter((m) => m.expiredAtMs === undefined);
    const vectors =
      this.options.embed && live.length > 0
        ? await this.options.embed(live.map((m) => m.text))
        : [];
    const put = this.#db.prepare(
      `INSERT INTO memories (user, id, kind, text, tags, created_at, pending, vector) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user, id) DO UPDATE SET kind = excluded.kind, text = excluded.text, tags = excluded.tags,
       created_at = excluded.created_at, pending = 0, vector = excluded.vector`,
    );
    live.forEach((m, i) => {
      const v = vectors[i];
      put.run(
        user,
        m.id,
        m.kind,
        m.text,
        JSON.stringify(m.tags),
        m.createdAtMs,
        v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null,
      );
    });
    const del = this.#db.prepare('DELETE FROM memories WHERE user = ? AND id = ?');
    for (const m of memories) if (m.expiredAtMs !== undefined) del.run(user, m.id);
  }

  /** Replays the scope's queued writes in order; stops at the first one the server cannot take yet. */
  async #flush(user: string): Promise<void> {
    const rows = this.#db
      .prepare('SELECT seq, op, body, local_id FROM queue WHERE user = ? ORDER BY seq')
      .all(user) as Array<{ seq: number; op: string; body: string; local_id: string | null }>;
    for (const row of rows) {
      const body = JSON.parse(row.body) as RememberOptions & {
        content?: string;
        ids?: string[];
        requestId: string;
      };
      try {
        if (row.op === 'remember') {
          const { content = '', ids: _ids, ...rest } = body;
          const done = await this.#api(user).remember(content, rest);
          await this.#store(user, done.memories);
        } else await this.#api(user).forget(body.ids ?? [], { requestId: body.requestId });
      } catch (e) {
        if (isRetryable(e)) return;
        this.options.onRejected?.(row.op, e);
      }
      if (row.local_id)
        this.#db.prepare('DELETE FROM memories WHERE user = ? AND id = ?').run(user, row.local_id);
      this.#db.prepare('DELETE FROM queue WHERE seq = ?').run(row.seq);
    }
  }

  #enqueue(user: string, op: string, body: Record<string, unknown>, localId?: string): void {
    this.#db
      .prepare('INSERT INTO queue (user, op, body, local_id) VALUES (?, ?, ?, ?)')
      .run(user, op, JSON.stringify(body), localId ?? null);
  }

  /**
   * Remembers `content`. Online, the server's answer is stored before this
   * returns (read-your-writes); offline, it is queued and readable at once
   * under a local id, which the server's id replaces once it is replayed.
   */
  remember(
    user: string,
    content: string,
    options: RememberOptions = {},
  ): Promise<{ ids: string[]; queued: boolean }> {
    const requestId = options.requestId ?? crypto.randomUUID();
    return this.#serial(async () => {
      const queued = this.#db.prepare('SELECT 1 FROM queue WHERE user = ? LIMIT 1').get(user);
      if (!queued && this.#connected.has(user)) {
        try {
          const done = await this.#api(user).remember(content, { ...options, requestId });
          await this.#store(user, done.memories);
          return { ids: done.ids, queued: false };
        } catch (e) {
          if (!isRetryable(e)) throw e;
        }
      }
      // Behind earlier queued writes too, so the order the caller saw is the order applied.
      const localId = `local:${requestId}`;
      const vector = this.options.embed ? (await this.options.embed([content]))[0] : undefined;
      this.#db
        .prepare(
          'INSERT OR REPLACE INTO memories (user, id, kind, text, tags, created_at, pending, vector) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        )
        .run(
          user,
          localId,
          options.kind ?? 'episodic',
          content,
          JSON.stringify(options.tags ?? []),
          Date.now(),
          vector ? new Uint8Array(vector.buffer) : null,
        );
      this.#enqueue(user, 'remember', { content, ...options, requestId }, localId);
      return { ids: [localId], queued: true };
    });
  }

  /** Forgets memories: at once locally, on the server now or once it can be reached. */
  forget(user: string, ids: readonly string[]): Promise<{ queued: boolean }> {
    const requestId = crypto.randomUUID();
    return this.#serial(async () => {
      const del = this.#db.prepare('DELETE FROM memories WHERE user = ? AND id = ?');
      for (const id of ids) del.run(user, id);
      // A memory written offline and never sent just leaves the queue.
      const local = ids.filter((id) => id.startsWith('local:'));
      for (const id of local)
        this.#db.prepare('DELETE FROM queue WHERE user = ? AND local_id = ?').run(user, id);
      const remote = ids.filter((id) => !id.startsWith('local:'));
      if (remote.length === 0) return { queued: false };
      const queued = this.#db.prepare('SELECT 1 FROM queue WHERE user = ? LIMIT 1').get(user);
      if (!queued && this.#connected.has(user)) {
        try {
          await this.#api(user).forget(remote, { requestId });
          return { queued: false };
        } catch (e) {
          if (!isRetryable(e)) throw e;
        }
      }
      this.#enqueue(user, 'forget', { ids: remote, requestId });
      return { queued: true };
    });
  }

  /** Local recall: BM25, fused with vector similarity when the replica embeds (RRF). */
  async recall(user: string, query: string, k = 10): Promise<LocalHit[]> {
    const rows = this.#db
      .prepare(
        'SELECT id, kind, text, tags, created_at, pending, vector FROM memories WHERE user = ?',
      )
      .all(user) as unknown as Row[];
    const rankings: string[][] = [
      [...bm25(rows, query)].sort((a, b) => b[1] - a[1]).map(([id]) => id),
    ];
    if (this.options.embed) {
      const [q] = await this.options.embed([query]);
      if (q)
        rankings.push(
          rows
            .filter((r) => r.vector)
            .map((r) => ({ id: r.id, s: cosine(q, asVector(r.vector as Uint8Array)) }))
            .sort((a, b) => b.s - a.s)
            .map((r) => r.id),
        );
    }
    const fused = new Map<string, number>();
    for (const ranking of rankings)
      ranking.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank + 1)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return [...fused]
      .sort((a, b) => b[1] - a[1])
      .slice(0, k)
      .map(([id, score]) => {
        const r = byId.get(id) as Row;
        return { id, text: r.text, kind: r.kind, score, pending: r.pending === 1 };
      });
  }

  /** Every local memory of a scope, oldest first. */
  list(user: string): LocalHit[] {
    const rows = this.#db
      .prepare(
        'SELECT id, kind, text, pending FROM memories WHERE user = ? ORDER BY created_at, id',
      )
      .all(user) as unknown as Row[];
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      kind: r.kind,
      score: 0,
      pending: r.pending === 1,
    }));
  }

  /** Writes still waiting for the server. */
  get queued(): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM queue').get() as { n: number }).n;
  }

  /** Waits for every queued step (changes, syncs, flushes) to finish. */
  settled(): Promise<void> {
    return this.#serial(() => Promise.resolve());
  }

  close(): void {
    this.#abort.abort();
    this.#db.close();
  }
}
