import { fromBinary } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { KeyFamily, decodeKey, err, isOk, keyPrefix, mindlogError, ok } from '@mindlog/core';
import {
  collectionKey,
  decodeRecord,
  decodeSchema,
  indexPrefix,
  recordKey,
  recordPrefix,
  schemaKey,
} from '@mindlog/collections';
import type { CollectionSchema } from '@mindlog/collections';
import type { KvReply } from '@mindlog/proto';
import { RecordWriteSchema, SchemaChangeSchema } from '@mindlog/proto';
import type { ScanPlan } from '@mindlog/rules';
import { compareValues } from '@mindlog/rules';
import type { CommandStamper } from '@mindlog/statemachine';
import { MvccReader } from '@mindlog/storage';
import { replies } from '@mindlog/kv';
import type { Caller, Placement, RangeCall, RangeRouter, RangeTarget } from '../kv/range-router.js';

/** A record as read from its range, before rules and presentation. */
export interface RawRecord {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly createdMs: number;
  readonly updatedMs: number;
  /** MVCC version, as a decimal string (JSON has no bigint). */
  readonly version: string;
}

export interface StoredCollection {
  readonly schema: CollectionSchema;
  readonly version: string;
}

/** What a collection's range serves, here or for another node (`collections.<op>` calls). */
export type RangeOp =
  | { readonly op: 'schema'; readonly collection: string }
  | { readonly op: 'catalog' }
  | { readonly op: 'get'; readonly collection: string; readonly ids: readonly string[] }
  | {
      readonly op: 'scan';
      readonly collection: string;
      readonly plan: ScanPlan;
      /** Resume after this raw key (hex). */
      readonly after?: string;
      readonly limit: number;
    }
  | {
      readonly op: 'propose';
      readonly body: 'recordWrite' | 'schemaChange';
      /** The body message, binary protobuf in base64. */
      readonly bytes: string;
      readonly actor: string;
    };

/** A proposal's ids and new versions (decimal strings; JSON has no bigint). */
export interface ProposeOutcome {
  readonly ids: string[];
  readonly versions: string[];
}

export interface ScanPage {
  readonly records: RawRecord[];
  /** Raw key (hex) to resume after; absent at the end. */
  readonly next?: string;
}

/** Prefix of forwarded collection calls on the shared memory-call RPC (ADR-0016). */
export const COLLECTION_OP_PREFIX = 'collections.';

const RETRYABLE = new Set(['NOT_LEADER', 'RANGE_MOVED']);
const PLACE_RETRYABLE = new Set(['NOT_FOUND', 'NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE']);
const MAX_RETRIES = 10;
const MAX_IDS = 1000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const backoff = (attempt: number) => delay(Math.min(1000, 20 * 2 ** attempt));
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

/**
 * Routes collection operations to the range that holds the collection
 * (ADR-0034), locally or through the forwarding RPC, with the same retries
 * as memory calls. Reads wait for the lease read barrier.
 */
export class CollectionRanges {
  constructor(
    private readonly d: { readonly router: RangeRouter; readonly stamper: CommandStamper },
  ) {}

  /** Runs `op` on the range of `collection`. */
  async run<T>(
    caller: Caller,
    collection: string,
    op: RangeOp,
    requestId?: Uint8Array,
  ): Promise<Result<T, MindlogError>> {
    const key = collectionKey(caller.tenant, collection);
    let placed = await this.#locate(key);
    for (let attempt = 0; ; attempt++) {
      if (!placed.ok) return placed;
      const result = await this.#once<T>(placed.value, caller, op, requestId);
      if (result.ok || !RETRYABLE.has(result.error.code) || attempt >= MAX_RETRIES) return result;
      await backoff(attempt);
      placed = this.d.router.refresh
        ? await this.d.router.refresh(placed.value)
        : await this.#locate(key);
    }
  }

  /** Every collection schema of the tenant, from every range. */
  async catalog(caller: Caller): Promise<Result<Map<string, StoredCollection>, MindlogError>> {
    const ranges = await this.d.router.ranges();
    if (!ranges.ok) return ranges;
    const out = new Map<string, StoredCollection>();
    for (const p of ranges.value) {
      const found = await this.#once<[string, StoredCollection][]>(p, caller, { op: 'catalog' });
      // A range that moved meanwhile is read again on the next refresh.
      if (!found.ok) {
        if (RETRYABLE.has(found.error.code) || found.error.code === 'UNAVAILABLE') continue;
        return found;
      }
      for (const [name, c] of found.value) out.set(name, c);
    }
    return ok(out);
  }

  async #locate(key: Uint8Array): Promise<Result<Placement, MindlogError>> {
    for (let attempt = 0; ; attempt++) {
      const placed = await this.d.router.locate(key);
      if (placed.ok || !PLACE_RETRYABLE.has(placed.error.code) || attempt >= MAX_RETRIES)
        return placed;
      await backoff(attempt);
    }
  }

  async #once<T>(
    p: Placement,
    caller: Caller,
    op: RangeOp,
    requestId?: Uint8Array,
  ): Promise<Result<T, MindlogError>> {
    const local = p.local ?? this.d.router.local(p.rangeId);
    if (local) return this.serve(local, caller, op, requestId) as Promise<Result<T, MindlogError>>;
    const call: RangeCall = {
      kind: 'memory',
      op: COLLECTION_OP_PREFIX + op.op,
      json: JSON.stringify(op),
      ...(requestId ? { requestId } : {}),
    };
    const reply = await this.d.router.forward(p, caller, call);
    if (!reply.ok) return reply;
    const kind = reply.value.kind;
    if (kind.case === 'error')
      return err(
        mindlogError(kind.value.code as MindlogError['code'], kind.value.message, {
          fields: kind.value.fields,
        }),
      );
    if (kind.case !== 'bulk')
      return err(mindlogError('INTERNAL', 'forwarded collection call returned no result'));
    return ok(JSON.parse(decoder.decode(kind.value)) as T);
  }

  /** Serves a forwarded call on this node's replica of `rangeId`. */
  async forwarded(rangeId: bigint, caller: Caller, call: RangeCall): Promise<KvReply> {
    if (call.kind !== 'memory' || !call.op.startsWith(COLLECTION_OP_PREFIX)) {
      return replies.error('INVALID_ARGUMENT', 'not a collection call');
    }
    const target = this.d.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${String(rangeId)}`);
    let op: RangeOp;
    try {
      op = JSON.parse(call.json) as RangeOp;
    } catch {
      return replies.error('INVALID_ARGUMENT', 'malformed collection call');
    }
    const result = await this.serve(target, caller, op, call.requestId);
    if (!result.ok) return replies.error(result.error.code, result.error.message);
    return replies.bulk(encoder.encode(JSON.stringify(result.value ?? null)));
  }

  /** Runs an op on a local replica. */
  async serve(
    target: RangeTarget,
    caller: Caller,
    op: RangeOp,
    requestId?: Uint8Array,
  ): Promise<Result<unknown, MindlogError>> {
    if (op.op === 'propose') return this.#propose(target, caller, op, requestId);
    const ready = await target.readBarrier.read('lease');
    if (!ready.ok) return ready;
    const reader = new MvccReader(target.reader);
    switch (op.op) {
      case 'schema': {
        if (!target.covers(collectionKey(caller.tenant, op.collection))) return movedFrom(target);
        const bytes = await reader.get(schemaKey(caller.tenant, op.collection));
        return ok(bytes === undefined ? null : stored(bytes));
      }
      case 'catalog':
        return ok(await catalogOf(reader, caller.tenant));
      case 'get': {
        if (!target.covers(collectionKey(caller.tenant, op.collection))) return movedFrom(target);
        const out: RawRecord[] = [];
        for (const id of op.ids.slice(0, MAX_IDS)) {
          const bytes = await reader.get(recordKey(caller.tenant, op.collection, id));
          if (bytes !== undefined) out.push(raw(id, bytes));
        }
        return ok(out);
      }
      case 'scan':
        if (!target.covers(collectionKey(caller.tenant, op.collection))) return movedFrom(target);
        return ok(await scan(reader, caller.tenant, op));
    }
  }

  async #propose(
    target: RangeTarget,
    caller: Caller,
    op: Extract<RangeOp, { op: 'propose' }>,
    requestId?: Uint8Array,
  ): Promise<Result<ProposeOutcome, MindlogError>> {
    const bytes = Buffer.from(op.bytes, 'base64');
    const body =
      op.body === 'recordWrite'
        ? { case: 'recordWrite' as const, value: fromBinary(RecordWriteSchema, bytes) }
        : { case: 'schemaChange' as const, value: fromBinary(SchemaChangeSchema, bytes) };
    const collection = body.value.collection;
    if (!target.covers(collectionKey(caller.tenant, collection))) return movedFrom(target);
    const command = this.d.stamper.stamp(caller.tenant, caller.principal, body, requestId);
    command.actor = op.actor;
    const proposed = await target.proposer.propose(command);
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case === 'error') {
      return err(
        mindlogError(outcome.value.code as MindlogError['code'], outcome.value.message, {
          fields: outcome.value.fields,
        }),
      );
    }
    if (outcome.case !== 'record') return err(mindlogError('INTERNAL', 'not a record result'));
    return ok({ ids: outcome.value.ids, versions: outcome.value.versions.map(String) });
  }
}

const movedFrom = (target: RangeTarget) =>
  err(mindlogError('RANGE_MOVED', `the collection left range ${String(target.rangeId)}`));

function stored(bytes: Uint8Array): StoredCollection {
  const s = decodeSchema(bytes);
  return { schema: s.schema, version: String(s.version) };
}

function raw(id: string, bytes: Uint8Array): RawRecord {
  const { stored: s, data } = decodeRecord(bytes);
  return {
    id,
    data,
    createdMs: Number(s.createdMs),
    updatedMs: Number(s.updatedMs),
    version: String(s.version),
  };
}

const tupleOf = (key: Uint8Array) => {
  const d = decodeKey(key);
  return isOk(d) ? d.value.tuple : [];
};

/** Schemas of every collection whose data this range holds. */
async function catalogOf(
  reader: MvccReader,
  tenant: string,
): Promise<[string, StoredCollection][]> {
  const family = keyPrefix(tenant, KeyFamily.COLLECTION);
  if (!family.ok) return [];
  const out: [string, StoredCollection][] = [];
  let after: Uint8Array | undefined;
  for (;;) {
    let next: Uint8Array | undefined;
    for await (const { key } of reader.scan(family.value, {
      limit: 1,
      ...(after ? { after } : {}),
    })) {
      const name = tupleOf(key)[0];
      if (typeof name !== 'string') break;
      const bytes = await reader.get(schemaKey(tenant, name));
      if (bytes !== undefined) out.push([name, stored(bytes)]);
      next = collectionKey(tenant, name);
    }
    if (!next) return out;
    after = next;
  }
}

async function scan(
  reader: MvccReader,
  tenant: string,
  op: Extract<RangeOp, { op: 'scan' }>,
): Promise<ScanPage> {
  const { collection, plan, limit } = op;
  const after = op.after === undefined ? undefined : Buffer.from(op.after, 'hex');
  const records: RawRecord[] = [];
  if (plan.kind === 'ids') {
    for (const id of plan.ids.slice(0, MAX_IDS)) {
      const bytes = await reader.get(recordKey(tenant, collection, id));
      if (bytes !== undefined) records.push(raw(id, bytes));
    }
    return { records };
  }
  if (plan.kind === 'scan') {
    let last: Uint8Array | undefined;
    for await (const { key, value } of reader.scan(recordPrefix(tenant, collection), {
      limit,
      ...(after ? { after } : {}),
    })) {
      records.push(raw(String(tupleOf(key).at(-1)), value));
      last = key;
    }
    return records.length < limit || !last ? { records } : { records, next: hex(last) };
  }
  // Index rows: (collection, 'x', index, ...eq, next field, …, id); bounds apply to the next field.
  const prefix = indexPrefix(
    tenant,
    collection,
    plan.index,
    plan.eq.map((v) => v as string | number | boolean),
  );
  const at = 3 + plan.eq.length;
  let rows = 0;
  let last: Uint8Array | undefined;
  for await (const { key } of reader.scan(prefix, { limit, ...(after ? { after } : {}) })) {
    rows++;
    last = key;
    const tuple = tupleOf(key);
    if (!(plan.range ?? []).every((b) => compareValues(b.op, tuple[at], b.value))) continue;
    const id = String(tuple.at(-1));
    const bytes = await reader.get(recordKey(tenant, collection, id));
    if (bytes !== undefined) records.push(raw(id, bytes));
  }
  return rows < limit || !last ? { records } : { records, next: hex(last) };
}
