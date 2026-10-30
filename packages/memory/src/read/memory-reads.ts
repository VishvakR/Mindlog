import { fromBinary } from '@bufbuild/protobuf';
import { decodeKey } from '@mindlog/core';
import type { Adjacency, GraphReader } from '@mindlog/index-graph';
import type { Bm25Stats, Posting, PostingReader } from '@mindlog/index-text';
import { decodeCount, decodePosting, decodeStats } from '@mindlog/index-text';
import type { MemoryConflict, MemoryEntity, MemoryRecord } from '@mindlog/proto';
import {
  MemoryConflictSchema,
  MemoryEdgeSchema,
  MemoryEntitySchema,
  MemoryRecordSchema,
} from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import {
  MvccReader,
  decodeVersionValue,
  keyAfter,
  parseVersionedKey,
  versionedKey,
} from '@mindlog/storage';
import type { EdgeDirection, Root } from '../keys.js';
import {
  conflictKey,
  conflictPrefix,
  dfKey,
  edgePrefix,
  entityKey,
  entityPrefix,
  generationKey,
  mentionPrefix,
  openConflictKey,
  openConflictPrefix,
  postingPrefix,
  recordKey,
  recordPrefix,
  statsKey,
} from '../keys.js';

const NEWEST = (1n << 64n) - 1n;

/** Prefix of memory nodes in the memory graph; entity ids never start with it. */
export const MEMORY_NODE = '@';

/** The last tuple element of a stored key (an id), or undefined. */
function lastElement(key: Uint8Array): unknown {
  const decoded = decodeKey(key);
  return decoded.ok ? decoded.value.tuple.at(-1) : undefined;
}

/**
 * Read access to one user scope's memory in a range's applied state
 * (ADR-0031): its main space or a branch space (ADR-0013), at the latest
 * version or as of `at` (PLAN 13.3 `ASOF`).
 */
export class MemoryReads {
  readonly #mvcc: MvccReader;
  readonly #raw: KvReader;
  readonly #at: bigint | undefined;
  readonly tenant: string;
  readonly user: Root;

  constructor(reader: KvReader, tenant: string, user: Root, at?: bigint) {
    this.#raw = reader;
    this.#mvcc = new MvccReader(reader);
    this.#at = at;
    this.tenant = tenant;
    this.user = user;
  }

  /** The version this reads at; undefined for the latest. */
  get at(): bigint | undefined {
    return this.#at;
  }

  #get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.#mvcc.get(key, this.#at);
  }

  #scan(prefix: Uint8Array, options: { after?: Uint8Array; limit?: number } = {}) {
    return this.#mvcc.scan(prefix, this.#at === undefined ? options : { ...options, at: this.#at });
  }

  async generation(): Promise<number> {
    return decodeCount(await this.#get(generationKey(this.tenant, this.user)));
  }

  async record(id: string): Promise<MemoryRecord | undefined> {
    const bytes = await this.#get(recordKey(this.tenant, this.user, id));
    return bytes ? fromBinary(MemoryRecordSchema, bytes) : undefined;
  }

  /** Records in id order (ULIDs, so creation order), after `after`. */
  async *records(after?: string): AsyncGenerator<MemoryRecord> {
    const options = after ? { after: recordKey(this.tenant, this.user, after) } : {};
    for await (const { value } of this.#scan(recordPrefix(this.tenant, this.user), options))
      yield fromBinary(MemoryRecordSchema, value);
  }

  /** Every stored state of a record, newest first, within MVCC retention. */
  async history(id: string): Promise<Array<{ version: bigint; record: MemoryRecord }>> {
    const logical = recordKey(this.tenant, this.user, id);
    const out: Array<{ version: bigint; record: MemoryRecord }> = [];
    const range = { start: versionedKey(logical, NEWEST), end: keyAfter(logical) };
    for await (const [raw, stored] of this.#raw.iterate(range)) {
      const parsed = parseVersionedKey(raw);
      const value = decodeVersionValue(stored);
      if (parsed && value)
        out.push({ version: parsed.index, record: fromBinary(MemoryRecordSchema, value) });
    }
    return out;
  }

  async conflict(id: string): Promise<MemoryConflict | undefined> {
    const bytes = await this.#get(conflictKey(this.tenant, this.user, id));
    return bytes ? fromBinary(MemoryConflictSchema, bytes) : undefined;
  }

  /** Conflicts in id order (oldest first), only open ones unless `all`. */
  async *conflicts(all: boolean, after?: string): AsyncGenerator<MemoryConflict> {
    const { tenant, user } = this;
    if (all) {
      const options = after ? { after: conflictKey(tenant, user, after) } : {};
      for await (const { value } of this.#scan(conflictPrefix(tenant, user), options))
        yield fromBinary(MemoryConflictSchema, value);
      return;
    }
    const options = after ? { after: openConflictKey(tenant, user, after) } : {};
    for await (const { key } of this.#scan(openConflictPrefix(tenant, user), options)) {
      const id = lastElement(key);
      const c = typeof id === 'string' ? await this.conflict(id) : undefined;
      if (c) yield c;
    }
  }

  async entity(id: string): Promise<MemoryEntity | undefined> {
    const bytes = await this.#get(entityKey(this.tenant, this.user, id));
    return bytes ? fromBinary(MemoryEntitySchema, bytes) : undefined;
  }

  /** Entities in id order (`type:name`). */
  async *entities(): AsyncGenerator<{ id: string; entity: MemoryEntity }> {
    for await (const { key, value } of this.#scan(entityPrefix(this.tenant, this.user))) {
      const id = lastElement(key);
      if (typeof id === 'string') yield { id, entity: fromBinary(MemoryEntitySchema, value) };
    }
  }

  /** Ids of the memories that mention an entity. */
  async mentions(entityId: string, limit = 1000): Promise<string[]> {
    const out: string[] = [];
    for await (const { key } of this.#scan(mentionPrefix(this.tenant, this.user, entityId), {
      limit,
    })) {
      const id = lastElement(key);
      if (typeof id === 'string') out.push(id);
    }
    return out;
  }

  postings(): PostingReader {
    const { tenant, user } = this;
    const get = (k: Uint8Array) => this.#get(k);
    const scan = (p: Uint8Array) => this.#scan(p);
    return {
      stats: async (): Promise<Bm25Stats> => decodeStats(await get(statsKey(tenant, user))),
      df: async (term) => decodeCount(await get(dfKey(tenant, user, term))),
      async *postings(term): AsyncGenerator<Posting & { id: string }> {
        for await (const { key, value } of scan(postingPrefix(tenant, user, term))) {
          const id = lastElement(key);
          if (typeof id === 'string') yield { id, ...decodePosting(value) };
        }
      },
    };
  }

  /**
   * The memory graph PPR walks (PLAN 11.3): entity nodes (`type:name`) and
   * memory nodes (`@` + id). Entities link to each other by their edges and to
   * up to `mentionLimit` memories mentioning them (weight 1); memories link to
   * their entities and their `related` notes. Forgotten memories have no edges.
   */
  memoryGraph(mentionLimit: number): GraphReader {
    const entities = this.graph();
    const mentions = (entity: string) => this.mentions(entity, mentionLimit);
    const record = (id: string) => this.record(id);
    return {
      async *neighbors(node): AsyncGenerator<Adjacency> {
        if (!node.startsWith(MEMORY_NODE)) {
          yield* entities.neighbors(node);
          for (const id of await mentions(node))
            yield { relation: 'mentions', node: MEMORY_NODE + id, direction: 'in', weight: 1 };
          return;
        }
        const r = await record(node.slice(MEMORY_NODE.length));
        if (!r || r.expiredAt !== 0n) return;
        for (const e of r.entities)
          yield { relation: 'mentions', node: e, direction: 'out', weight: 1 };
        for (const l of r.links)
          yield {
            relation: l.relation,
            node: MEMORY_NODE + l.to,
            direction: 'out',
            weight: l.weight,
          };
      },
    };
  }

  graph(): GraphReader {
    const { tenant, user } = this;
    const scan = (p: Uint8Array) => this.#scan(p);
    return {
      async *neighbors(node): AsyncGenerator<Adjacency> {
        for (const direction of ['out', 'in'] as EdgeDirection[]) {
          for await (const { key, value } of scan(edgePrefix(tenant, user, direction, node))) {
            const decoded = decodeKey(key);
            if (!decoded.ok) continue;
            const [relation, other] = decoded.value.tuple.slice(-2);
            if (typeof relation !== 'string' || typeof other !== 'string') continue;
            const weight = fromBinary(MemoryEdgeSchema, value).weight;
            yield { relation, node: other, direction, weight };
          }
        }
      },
    };
  }
}
