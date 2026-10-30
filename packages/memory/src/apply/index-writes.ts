import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { entityId } from '@mindlog/index-graph';
import {
  decodeCount,
  decodeStats,
  encodeCount,
  encodePosting,
  encodeStats,
} from '@mindlog/index-text';
import type { EntityEdge, MemoryRecord, NewMemory } from '@mindlog/proto';
import {
  MemoryEdgeSchema,
  MemoryEntitySchema,
  MemoryRecordSchema,
  MemoryVectorSchema,
} from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import type { Root } from '../keys.js';
import {
  derivedKey,
  dfKey,
  edgeKey,
  entityKey,
  generationKey,
  indexTimeKey,
  mentionKey,
  postingKey,
  recordKey,
  sourceRefKey,
  statsKey,
  vectorKey,
} from '../keys.js';

const EMPTY = new Uint8Array();

/** Memories an edge remembers as its support (the newest win). */
const EDGE_SUPPORT = 20;

async function count(ctx: ApplyContext, key: Uint8Array): Promise<number> {
  return decodeCount(await ctx.txn.get(key));
}

function setCount(ctx: ApplyContext, key: Uint8Array, n: number): void {
  if (n <= 0) ctx.txn.delete(key);
  else ctx.txn.put(key, encodeCount(n));
}

async function addStats(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  docs: number,
  length: number,
): Promise<void> {
  const key = statsKey(tenant, user);
  const s = decodeStats(await ctx.txn.get(key));
  ctx.txn.put(
    key,
    encodeStats({
      docs: Math.max(0, s.docs + docs),
      totalLength: Math.max(0, s.totalLength + length),
    }),
  );
}

async function addMention(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  name: string,
  type: string,
  delta: number,
): Promise<string> {
  const id = entityId(type, name);
  const key = entityKey(tenant, user, id);
  const bytes = await ctx.txn.get(key);
  const entity = bytes
    ? fromBinary(MemoryEntitySchema, bytes)
    : create(MemoryEntitySchema, {
        name: name.trim(),
        type: type.toLowerCase(),
        createdAt: ctx.version,
      });
  entity.mentionCount = Math.max(0, entity.mentionCount + delta);
  ctx.txn.put(key, toBinary(MemoryEntitySchema, entity));
  return id;
}

/** Stores one new memory and indexes it: vector, postings, BM25 stats and entity mentions. */
export async function writeMemory(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  m: NewMemory,
): Promise<string> {
  const record = create(MemoryRecordSchema, m.record);
  record.createdAt = ctx.version;
  record.logIndex = ctx.index;
  record.expiredAt = 0n;
  const ids: string[] = [];
  for (const mention of m.mentions) {
    const id = entityId(mention.type, mention.name);
    if (ids.includes(id)) continue;
    ids.push(await addMention(ctx, tenant, user, mention.name, mention.type, 1));
    ctx.txn.put(mentionKey(tenant, user, id, record.id), new Uint8Array());
  }
  record.entities = ids;
  ctx.txn.put(recordKey(tenant, user, record.id), toBinary(MemoryRecordSchema, record));
  // Kept after forgetting, so a later taint cascade still reaches what was derived.
  if (record.source?.ref)
    ctx.txn.put(sourceRefKey(tenant, user, record.source.ref, record.id), EMPTY);
  for (const l of record.links)
    if (l.relation === 'derived_from')
      ctx.txn.put(derivedKey(tenant, user, l.to, record.id), EMPTY);
  if (m.vector.length > 0)
    ctx.txn.put(
      vectorKey(tenant, user, record.id),
      toBinary(
        MemoryVectorSchema,
        create(MemoryVectorSchema, {
          modelId: record.embeddingModel,
          vector: m.vector,
          kind: record.kind,
          trust: record.trust,
          agent: record.agent,
          session: record.session,
        }),
      ),
    );
  for (const { term, count: tf } of record.terms) {
    ctx.txn.put(
      postingKey(tenant, user, term, record.id),
      encodePosting({ tf, length: record.termLength }),
    );
    setCount(ctx, dfKey(tenant, user, term), (await count(ctx, dfKey(tenant, user, term))) + 1);
  }
  await addStats(ctx, tenant, user, 1, record.termLength);
  return record.id;
}

/** Forgets one memory (append-only): expires the record and removes it from every index. */
export async function forgetMemory(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  record: MemoryRecord,
  reason: string,
): Promise<void> {
  record.expiredAt = ctx.version;
  record.forgetReason = reason;
  ctx.txn.put(recordKey(tenant, user, record.id), toBinary(MemoryRecordSchema, record));
  ctx.txn.delete(vectorKey(tenant, user, record.id));
  for (const { term } of record.terms) {
    ctx.txn.delete(postingKey(tenant, user, term, record.id));
    setCount(ctx, dfKey(tenant, user, term), (await count(ctx, dfKey(tenant, user, term))) - 1);
  }
  await addStats(ctx, tenant, user, -1, -record.termLength);
  for (const id of record.entities) {
    ctx.txn.delete(mentionKey(tenant, user, id, record.id));
    const bytes = await ctx.txn.get(entityKey(tenant, user, id));
    if (!bytes) continue;
    const entity = fromBinary(MemoryEntitySchema, bytes);
    entity.mentionCount = Math.max(0, entity.mentionCount - 1);
    ctx.txn.put(entityKey(tenant, user, id), toBinary(MemoryEntitySchema, entity));
  }
}

/** An entity relation, stored in both directions; repeated statements add weight. */
export async function writeEdge(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  e: EntityEdge,
): Promise<void> {
  const src = await addMention(ctx, tenant, user, e.srcName, e.srcType, 0);
  const dst = await addMention(ctx, tenant, user, e.dstName, e.dstType, 0);
  const relation = e.relation.trim().toLowerCase();
  for (const [key] of [
    [edgeKey(tenant, user, 'out', src, relation, dst)],
    [edgeKey(tenant, user, 'in', dst, relation, src)],
  ] as const) {
    const bytes = await ctx.txn.get(key);
    const edge = bytes
      ? fromBinary(MemoryEdgeSchema, bytes)
      : create(MemoryEdgeSchema, { createdAt: ctx.version });
    edge.weight += e.weight || 1;
    if (e.memoryId)
      edge.memories = [...edge.memories.filter((m) => m !== e.memoryId), e.memoryId].slice(
        -EDGE_SUPPORT,
      );
    ctx.txn.put(key, toBinary(MemoryEdgeSchema, edge));
  }
}

/** Marks the scope changed, so cached vector indexes notice (ADR-0008). */
export async function bumpGeneration(ctx: ApplyContext, tenant: string, user: Root): Promise<void> {
  const key = generationKey(tenant, user);
  ctx.txn.put(key, encodeCount((await count(ctx, key)) + 1));
}

/** Records the version of this log index for `ASOF index` (PLAN 13.3). */
export function writeIndexTime(ctx: ApplyContext, tenant: string, user: string): void {
  const value = new Uint8Array(8);
  new DataView(value.buffer).setBigUint64(0, ctx.version);
  ctx.txn.put(indexTimeKey(tenant, user, ctx.index), value);
}
