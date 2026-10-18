import { fromBinary } from '@bufbuild/protobuf';
import type { Logger, Metrics } from '@mindlog/core';
import { decodeKey } from '@mindlog/core';
import type { EventBus, Unsubscribe } from '@mindlog/eventbus';
import { FlatIndex } from '@mindlog/index-vector';
import type { MemoryVector } from '@mindlog/proto';
import { MemoryVectorSchema } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { vectorKey, vectorPrefix } from './keys.js';
import { MemoryReads } from './read/memory-reads.js';

/** What recall filters vectors by, copied into each vector row. */
export interface VectorMeta {
  readonly kind: string;
  readonly trust: string;
  readonly agent: string;
  readonly session: string;
}

interface Entry {
  index: FlatIndex<VectorMeta> | undefined;
  generation: number;
  /** Updates from applied commands, chained so they land in apply order. */
  pending: Promise<void>;
}

export interface VectorCacheOptions {
  /** The node's state store. */
  readonly state: KvReader;
  /** Scopes kept in memory (least recently used dropped first). */
  readonly maxScopes: number;
  readonly metrics?: Metrics;
  readonly logger?: Logger;
}

export function decodeVector(row: MemoryVector): Float32Array {
  const view = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
  const out = new Float32Array(row.vector.byteLength / 4);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

const meta = (row: MemoryVector): VectorMeta => ({
  kind: row.kind,
  trust: row.trust,
  agent: row.agent,
  session: row.session,
});

/**
 * In-memory `FlatIndex` per user scope (ADR-0008). The `m/(user, 'v')` rows are
 * the truth: an index is built from them on first use and kept current from
 * applied commands; a generation mismatch (snapshot, missed event) rebuilds it.
 */
export class VectorCache {
  readonly #o: VectorCacheOptions;
  readonly #mvcc: MvccReader;
  readonly #entries = new Map<string, Entry>();

  constructor(options: VectorCacheOptions) {
    this.#o = options;
    this.#mvcc = new MvccReader(options.state);
  }

  /** Follows memory commands applied on this node. */
  attach(bus: EventBus): Unsubscribe {
    return bus.subscribe('CommandApplied', ({ command }) => {
      const body = command.body;
      if (body.case !== 'memoryCommit' && body.case !== 'memoryForget') return;
      const entry = this.#entries.get(`${command.tenant}\u0000${body.value.user}`);
      if (!entry) return;
      const ids =
        body.case === 'memoryCommit'
          ? body.value.memories.map((m) => m.record?.id ?? '')
          : body.value.ids;
      entry.pending = entry.pending.then(() =>
        this.#update(entry, command.tenant, body.value.user, ids),
      );
    });
  }

  async #update(entry: Entry, tenant: string, user: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const bytes = await this.#mvcc.get(vectorKey(tenant, user, id));
      if (!bytes) {
        entry.index?.remove(id);
        continue;
      }
      this.#upsert(entry, id, fromBinary(MemoryVectorSchema, bytes));
    }
    entry.generation = await new MemoryReads(this.#o.state, tenant, user).generation();
  }

  #upsert(entry: Entry, id: string, row: MemoryVector): void {
    const vector = decodeVector(row);
    entry.index ??= new FlatIndex<VectorMeta>(vector.length);
    // A vector of another model's size waits for re-embedding (PLAN 14.5).
    if (vector.length === entry.index.dims) entry.index.upsert(id, vector, meta(row));
  }

  /** The scope's index as of its current generation; undefined when it has no vectors. */
  async index(tenant: string, user: string): Promise<FlatIndex<VectorMeta> | undefined> {
    const name = `${tenant}\u0000${user}`;
    const generation = await new MemoryReads(this.#o.state, tenant, user).generation();
    let entry = this.#entries.get(name);
    if (entry) {
      await entry.pending;
      this.#entries.delete(name);
      this.#entries.set(name, entry); // most recently used
    }
    if (!entry || entry.generation !== generation)
      entry = await this.#rebuild(name, tenant, user, generation);
    return entry.index;
  }

  async #rebuild(name: string, tenant: string, user: string, generation: number): Promise<Entry> {
    this.#o.metrics
      ?.counter({
        name: 'mindlog_memory_vector_rebuilds_total',
        help: 'Vector indexes rebuilt from storage',
      })
      .inc();
    const entry: Entry = { index: undefined, generation, pending: Promise.resolve() };
    for await (const { key, value } of this.#mvcc.scan(vectorPrefix(tenant, user))) {
      const decoded = decodeKey(key);
      const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
      if (typeof id === 'string') this.#upsert(entry, id, fromBinary(MemoryVectorSchema, value));
    }
    this.#entries.set(name, entry);
    while (this.#entries.size > this.#o.maxScopes) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return entry;
  }

  /** Drops every cached index (they rebuild on next use). */
  clear(): void {
    this.#entries.clear();
  }
}
