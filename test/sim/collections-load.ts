import { create } from '@bufbuild/protobuf';
import {
  collectionKey,
  decodeRecord,
  indexPrefix,
  recordKey,
  recordPrefix,
  uniquePrefix,
} from '@mindlog/collections';
import { decodeKey } from '@mindlog/core';
import type { Store } from '@mindlog/multiraft';
import type { Command, CommandResult } from '@mindlog/proto';
import { RecordOpKind, RecordOpSchema } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import { SpanReader, inSpan } from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import type { World } from './world.js';

const TENANT = 'default';
const COLLECTION = 'items';
const SLUGS = ['a', 'b', 'c', 'd', 'e', 'f'];
const enc = new TextEncoder();
const dec = new TextDecoder();
const RETRY = new Set(['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED', 'BUSY']);

export interface CollectionsNode {
  readonly id: bigint;
  readonly store: Store;
  readonly stateStore: KvStore;
  readonly stamper: CommandStamper;
}

export interface CollectionsLoadDeps {
  readonly world: World;
  readonly nodes: () => CollectionsNode[];
  readonly say: (line: string) => void;
  readonly violate: (what: string) => void;
}

/**
 * The collections workload (phase 9, ADR-0034): concurrent creates, updates
 * and deletes on a collection with a unique index, under the run's faults.
 * After healing, unique values are unique, every claim and index row matches
 * a record, and every acknowledged write is there.
 */
export class CollectionsLoad {
  readonly #d: CollectionsLoadDeps;
  #seq = 0;
  #ready = false;
  /** Acknowledged state: id → slug, or `null` once deleted. */
  readonly acked = new Map<string, string | null>();
  inFlight = 0;
  /** Deletes whose answer was lost: they may have applied. */
  readonly #maybeDeleted = new Set<string>();
  counts = { created: 0, updated: 0, deleted: 0, refused: 0 };

  constructor(deps: CollectionsLoadDeps) {
    this.#d = deps;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#d.world.at(this.#d.world.now + ms, resolve);
    });
  }

  #leader() {
    const key = collectionKey(TENANT, COLLECTION);
    for (const n of this.#d.nodes())
      for (const r of n.store.replicas())
        if (r.initialised && r.isLeader() && r.rangeId !== 0n && inSpan(r.descriptor, key))
          return { n, r };
    return undefined;
  }

  /** Proposes one stamped command until some leader answers; the request id makes retries apply once. */
  async #propose(make: (stamper: CommandStamper) => Command): Promise<CommandResult | undefined> {
    let command: Command | undefined;
    for (let tries = 0; tries < 12; tries++) {
      const at = this.#leader();
      if (at) {
        command ??= make(at.n.stamper);
        const done = await Promise.race([
          at.r.propose(command),
          this.#sleep(5000).then(() => undefined),
        ]);
        if (done?.ok) {
          const out = done.value.result.outcome;
          if (out.case !== 'error' || !RETRY.has(out.value.code)) return done.value.result;
        }
      }
      await this.#sleep(100 * Math.min(tries + 1, 5));
    }
    return undefined;
  }

  async setup(): Promise<void> {
    const schema = {
      name: COLLECTION,
      fields: [
        { name: 'slug', type: 'text' },
        { name: 'n', type: 'number' },
      ],
      indexes: [
        { name: 'by_slug', fields: ['slug'], unique: true },
        { name: 'by_n', fields: ['n'] },
      ],
    };
    for (;;) {
      const r = await this.#propose((s) =>
        s.stamp(TENANT, 'sim', {
          case: 'schemaChange',
          value: {
            collection: COLLECTION,
            schema: enc.encode(JSON.stringify(schema)),
            expectVersion: 0n,
          },
        }),
      );
      // CONFLICT: an earlier attempt created it.
      if (
        r &&
        (r.outcome.case === 'record' ||
          (r.outcome.case === 'error' && r.outcome.value.code === 'CONFLICT'))
      )
        break;
      await this.#sleep(300);
    }
    this.#ready = true;
    this.#d.say('collections: schema created');
  }

  /** One random create, update or delete. */
  async step(): Promise<void> {
    if (!this.#ready) return;
    const { world } = this.#d;
    const known = [...this.acked].filter(([, slug]) => slug !== null).map(([id]) => id);
    const roll = world.between(0, 1);
    const slug = SLUGS[Math.floor(world.between(0, SLUGS.length))] ?? 'a';
    const n = Math.floor(world.between(0, 5));
    this.inFlight++;
    try {
      if (roll < 0.5 || known.length === 0) {
        const id = `sim${String(this.#seq++).padStart(12, '0')}`;
        const r = await this.#write(RecordOpKind.CREATE, id, { slug, n }, 0n);
        if (r === 'ok') {
          this.acked.set(id, slug);
          this.counts.created++;
        }
        return;
      }
      const id = known[Math.floor(world.between(0, known.length))] ?? '';
      const version = await this.#version(id);
      if (version === undefined) return;
      const del = roll > 0.85;
      const r = await this.#write(
        del ? RecordOpKind.DELETE : RecordOpKind.UPDATE,
        id,
        del ? undefined : { slug, n },
        version,
      );
      if (r === 'ok') {
        // An update's answer can arrive after a later delete's; the delete stands.
        if (del || this.acked.get(id) !== null) this.acked.set(id, del ? null : slug);
        this.counts[del ? 'deleted' : 'updated']++;
      } else if (r === 'unknown' && del) this.#maybeDeleted.add(id);
    } finally {
      this.inFlight--;
    }
  }

  async #write(
    kind: RecordOpKind,
    id: string,
    data: unknown,
    expectVersion: bigint,
  ): Promise<'ok' | 'refused' | 'unknown'> {
    const op = create(RecordOpSchema, {
      kind,
      id,
      data: data === undefined ? new Uint8Array() : enc.encode(JSON.stringify(data)),
      expectVersion,
    });
    const started = this.#d.world.now;
    const r = await this.#propose((s) =>
      s.stamp(TENANT, 'sim', {
        case: 'recordWrite',
        value: { collection: COLLECTION, ops: [op], enqueue: [] },
      }),
    );
    this.#d.say(
      `collections: ${RecordOpKind[kind]} ${id} v${String(expectVersion)} → ${r === undefined ? 'unknown' : r.outcome.case === 'error' ? r.outcome.value.code : 'ok'} (from ${started.toFixed(0)})`,
    );
    if (r === undefined) return 'unknown';
    if (r.outcome.case === 'record') return 'ok';
    const code = r.outcome.case === 'error' ? r.outcome.value.code : '';
    if (!['ALREADY_EXISTS', 'CONFLICT', 'NOT_FOUND'].includes(code))
      this.#d.violate(`collections: write failed with ${code}`);
    this.counts.refused++;
    return 'refused';
  }

  async #version(id: string): Promise<bigint | undefined> {
    const at = this.#leader();
    if (!at) return undefined;
    const ready = await at.r.read('lease');
    if (!ready.ok) return undefined;
    const bytes = await new MvccReader(new SpanReader(at.n.stateStore, at.r.descriptor)).get(
      recordKey(TENANT, COLLECTION, id),
    );
    return bytes === undefined ? undefined : decodeRecord(bytes).stored.version;
  }

  /** After healing, on the leader's state. */
  async check(): Promise<void> {
    if (!this.#ready) return;
    const at = this.#leader();
    if (!at) {
      this.#d.violate('collections: no leader after healing');
      return;
    }
    const reader = new MvccReader(new SpanReader(at.n.stateStore, at.r.descriptor));
    const last = (key: Uint8Array) => {
      const d = decodeKey(key);
      return d.ok ? d.value.tuple : [];
    };
    const records = new Map<string, { slug: string; n: number }>();
    for await (const { key, value } of reader.scan(recordPrefix(TENANT, COLLECTION))) {
      const data = decodeRecord(value).data as { slug: string; n: number };
      records.set(String(last(key).at(-1)), data);
    }
    const bySlug = new Map<string, string>();
    for (const [id, r] of records) {
      const other = bySlug.get(r.slug);
      if (other !== undefined)
        this.#d.violate(`collections: ${id} and ${other} share slug ${r.slug}`);
      bySlug.set(r.slug, id);
    }
    let claims = 0;
    for await (const { key, value } of reader.scan(uniquePrefix(TENANT, COLLECTION))) {
      claims++;
      const slug = String(last(key).at(-1));
      const holder = dec.decode(value);
      if (records.get(holder)?.slug !== slug)
        this.#d.violate(`collections: claim ${slug} → ${holder} has no such record`);
    }
    if (claims !== bySlug.size)
      this.#d.violate(`collections: ${String(claims)} claims for ${String(bySlug.size)} slugs`);
    for (const index of ['by_slug', 'by_n']) {
      let rows = 0;
      for await (const { key } of reader.scan(indexPrefix(TENANT, COLLECTION, index))) {
        rows++;
        const tuple = last(key);
        const r = records.get(String(tuple.at(-1)));
        const field = index === 'by_slug' ? r?.slug : r?.n;
        if (r === undefined || tuple.at(-2) !== field)
          this.#d.violate(`collections: stale ${index} row ${String(tuple.at(-1))}`);
      }
      if (rows !== records.size)
        this.#d.violate(
          `collections: ${index} has ${String(rows)} rows for ${String(records.size)} records`,
        );
    }
    for (const [id, slug] of this.acked) {
      // A later write whose answer was lost may have changed it; an acknowledged delete must hold.
      if (slug === null && records.has(id)) this.#d.violate(`collections: deleted ${id} is back`);
      if (slug !== null && !records.has(id) && !this.#maybeDeleted.has(id))
        this.#d.violate(`collections: acknowledged ${id} is missing`);
    }
  }
}
