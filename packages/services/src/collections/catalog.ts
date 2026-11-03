import type { Clock, MindlogError, Result } from '@mindlog/core';
import { ok } from '@mindlog/core';
import type { CollectionSchema } from '@mindlog/collections';
import { schemaView } from '@mindlog/collections';
import type { SchemaView } from '@mindlog/rules';
import type { Caller } from '../kv/range-router.js';
import type { CollectionRanges, StoredCollection } from './collection-ranges.js';

/**
 * Collection schemas per tenant, read from every range and cached briefly.
 * shortcut: another node's schema change is seen after at most `ttlMs`; push
 * invalidations over the change feed if that window matters.
 */
export class Catalog {
  readonly #cache = new Map<string, { atMs: number; map: Map<string, StoredCollection> }>();

  constructor(
    private readonly d: {
      readonly ranges: CollectionRanges;
      readonly clock: Clock;
      readonly ttlMs?: number;
    },
  ) {}

  async all(caller: Caller): Promise<Result<ReadonlyMap<string, StoredCollection>, MindlogError>> {
    const now = Number(this.d.clock.now());
    const hit = this.#cache.get(caller.tenant);
    if (hit && now - hit.atMs < (this.d.ttlMs ?? 2000)) return ok(hit.map);
    const read = await this.d.ranges.catalog(caller);
    if (!read.ok) return read;
    this.#cache.set(caller.tenant, { atMs: now, map: read.value });
    return ok(read.value);
  }

  async get(
    caller: Caller,
    name: string,
  ): Promise<Result<StoredCollection | undefined, MindlogError>> {
    const all = await this.all(caller);
    return all.ok ? ok(all.value.get(name)) : all;
  }

  /** The schemas as `@mindlog/rules` sees them. */
  async view(caller: Caller): Promise<Result<SchemaView, MindlogError>> {
    const all = await this.all(caller);
    if (!all.ok) return all;
    const schemas = new Map<string, CollectionSchema>(
      [...all.value].map(([n, c]) => [n, c.schema]),
    );
    return ok(schemaView(schemas));
  }

  invalidate(tenant: string): void {
    this.#cache.delete(tenant);
  }
}
