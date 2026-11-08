import { randomBytes } from 'node:crypto';
import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { principalOf } from '@mindlog/auth';
import { collectionScope } from '@mindlog/jobs';
import type { ChangeEvent, ChangeFeed, Resync } from '../memory/change-feed.js';
import type { RawRecord } from './collection-ranges.js';
import type { CollectionService } from './collection-service.js';
import type { RecordView, RequestContext } from './record-reader.js';
import { ruleRecord } from './record-reader.js';

export interface RealtimeMessage {
  /** Cursor for `Last-Event-ID`. */
  readonly id: string;
  /** The subscription it matched, e.g. `todos/*`. */
  readonly event: string;
  readonly data:
    | { readonly action: 'create' | 'update' | 'delete'; readonly record: RecordView }
    | Record<string, never>;
}

interface Client {
  readonly id: string;
  readonly send: (m: RealtimeMessage) => void;
  readonly close: () => void;
  readonly resumeFrom: string | undefined;
  ctx?: RequestContext;
  /** Re-checks the subscriber's credential (expiry, revocation). */
  stillValid: () => Promise<boolean>;
  checkedAtMs: number;
  topics: Set<string>;
  /** Feed subscriptions by collection. */
  readonly feeds: Map<string, () => void>;
  /** One event at a time, so a client sees changes in order. */
  chain: Promise<void>;
  pending: number;
}

const MAX_CLIENTS = 10_000;
const MAX_TOPICS = 256;
const MAX_PENDING = 1000;
const RECHECK_MS = 30_000;
const TOPIC = /^([A-Za-z_][A-Za-z0-9_]*)\/(\*|[A-Za-z0-9]+)$/;
const ACTIONS = {
  'record.created': 'create',
  'record.updated': 'update',
  'record.deleted': 'delete',
} as const;

/**
 * Realtime record events (PLAN 16.6): clients subscribe to `collection/*` or
 * `collection/id`; each change is checked against `listRule` or `viewRule` as
 * that subscriber before it is sent.
 *
 * shortcut: a resume cursor names one range, so a client following collections
 * in several ranges replays only that range's; refetch on reconnect if that matters.
 */
export class RecordBroker {
  readonly #clients = new Map<string, Client>();

  constructor(
    private readonly d: {
      readonly collections: CollectionService;
      readonly feed: ChangeFeed;
      readonly clock: Clock;
    },
  ) {}

  connect(
    send: (m: RealtimeMessage) => void,
    close: () => void,
    resumeFrom: string | undefined,
  ): Result<string, MindlogError> {
    if (this.#clients.size >= MAX_CLIENTS)
      return err(mindlogError('BUSY', 'too many realtime clients'));
    const id = randomBytes(16).toString('hex');
    this.#clients.set(id, {
      id,
      send,
      close,
      resumeFrom,
      stillValid: () => Promise.resolve(true),
      checkedAtMs: Number(this.d.clock.now()),
      topics: new Set(),
      feeds: new Map(),
      chain: Promise.resolve(),
      pending: 0,
    });
    return ok(id);
  }

  disconnect(id: string): void {
    const client = this.#clients.get(id);
    for (const stop of client?.feeds.values() ?? []) stop();
    this.#clients.delete(id);
  }

  /** Replaces the client's subscriptions; the request's credential becomes the subscriber's. */
  subscribe(
    id: string,
    ctx: RequestContext,
    topics: readonly string[],
    stillValid: () => Promise<boolean>,
  ): Result<void, MindlogError> {
    const client = this.#clients.get(id);
    if (!client) return err(mindlogError('NOT_FOUND', 'Missing or invalid client id.'));
    if (client.ctx && principalOf(client.ctx.identity) !== principalOf(ctx.identity)) {
      return err(
        mindlogError(
          'PERMISSION_DENIED',
          "The current and the previous request authorization don't match.",
        ),
      );
    }
    if (topics.length > MAX_TOPICS)
      return err(mindlogError('INVALID_ARGUMENT', `at most ${String(MAX_TOPICS)} subscriptions`));
    const bad = topics.find((t) => !TOPIC.test(t));
    if (bad !== undefined)
      return err(mindlogError('INVALID_ARGUMENT', `invalid subscription ${bad}`));
    client.ctx = { ...ctx, context: 'realtime' };
    client.stillValid = stillValid;
    client.topics = new Set(topics);
    const wanted = new Set(topics.map((t) => t.split('/')[0] ?? ''));
    for (const [name, stop] of client.feeds) {
      if (wanted.has(name)) continue;
      stop();
      client.feeds.delete(name);
    }
    for (const name of wanted) {
      if (client.feeds.has(name)) continue;
      const stop = this.d.feed.subscribe(
        { tenant: ctx.tenant, user: collectionScope(name) },
        client.resumeFrom,
        (e) => {
          this.#enqueue(client, e);
        },
      );
      client.feeds.set(name, stop);
    }
    return ok(undefined);
  }

  #enqueue(client: Client, e: ChangeEvent | Resync): void {
    if (++client.pending > MAX_PENDING) {
      // A subscriber this far behind reconnects and re-reads.
      this.disconnect(client.id);
      client.close();
      return;
    }
    client.chain = client.chain
      .then(() => this.#deliver(client, e))
      .catch(() => undefined)
      .finally(() => {
        client.pending--;
      });
  }

  async #deliver(client: Client, e: ChangeEvent | Resync): Promise<void> {
    if (e.type === 'resync') {
      client.send({ id: '', event: 'resync', data: {} });
      return;
    }
    if (!(e.type in ACTIONS) || e.collection === undefined || !client.ctx) return;
    const now = Number(this.d.clock.now());
    if (now - client.checkedAtMs > RECHECK_MS) {
      client.checkedAtMs = now;
      if (!(await client.stillValid())) {
        this.disconnect(client.id);
        client.close();
        return;
      }
    }
    const collection = e.collection;
    const id = e.ids[0] ?? '';
    const reader = await this.d.collections.reader(client.ctx);
    if (!reader.ok) return;
    const schema = reader.value.schema(collection);
    if (!schema.ok) return;
    const action = ACTIONS[e.type as keyof typeof ACTIONS];
    let record: RawRecord | undefined;
    if (e.deleted)
      record = { id, data: e.deleted, createdMs: e.atMs, updatedMs: e.atMs, version: '0' };
    else {
      const found = await reader.value.get(collection, [id]);
      record = found.ok ? found.value[0] : undefined;
    }
    if (!record) return;
    const asRule = ruleRecord(collection, record);
    for (const [topic, rule] of [
      [`${collection}/*`, schema.value.listRule],
      [`${collection}/${id}`, schema.value.viewRule],
    ] as const) {
      if (!client.topics.has(topic)) continue;
      const allowed = await reader.value.allows(rule, collection, asRule);
      if (allowed.ok && allowed.value) {
        client.send({
          id: e.cursor,
          event: topic,
          data: { action, record: reader.value.present(collection, record) },
        });
      }
    }
  }
}
