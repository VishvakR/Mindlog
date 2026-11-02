import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { completeJob, enqueueJob } from '@mindlog/jobs';
import type { MemoryEvolve, MemoryRecord, TierMove } from '@mindlog/proto';
import { MemoryEntitySchema, MemoryRecordSchema, MemoryVectorSchema } from '@mindlog/proto';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { entityKey, recordKey, vectorKey, versionKey } from '../keys.js';
import { markEnqueued, strengthAfterRecall, updateLifecycle } from '../lifecycle.js';
import { hlcMs } from '../view.js';
import { readRecord } from './conflict-writes.js';
import { bumpGeneration } from './index-writes.js';
import { outcome, outsideRange } from './results.js';

const DAY_MS = 86_400_000;

const onBranch = (ctx: ApplyContext) =>
  ctx.command.branch !== '' && ctx.command.branch !== 'main'
    ? errorResult('INVALID_ARGUMENT', 'lifecycle changes apply to main only')
    : undefined;

function putRecord(ctx: ApplyContext, user: string, r: MemoryRecord): void {
  ctx.txn.put(recordKey(ctx.command.tenant, user, r.id), toBinary(MemoryRecordSchema, r));
}

function putVector(ctx: ApplyContext, user: string, r: MemoryRecord, vector: Uint8Array): void {
  ctx.txn.put(
    vectorKey(ctx.command.tenant, user, r.id),
    toBinary(
      MemoryVectorSchema,
      create(MemoryVectorSchema, {
        modelId: r.embeddingModel,
        vector,
        kind: r.kind,
        trust: r.trust,
        agent: r.agent,
        session: r.session,
      }),
    ),
  );
}

/** A new version of a record; the old one is kept at m/(user, 'rv', id, version). */
function evolve(ctx: ApplyContext, user: string, r: MemoryRecord, e: MemoryEvolve): void {
  ctx.txn.put(
    versionKey(ctx.command.tenant, user, r.id, r.version),
    toBinary(MemoryRecordSchema, r),
  );
  if (e.setTags) r.tags = [...e.tags];
  if (e.setImportance) r.importance = e.importance;
  if (e.metaJson !== '') {
    const before = r.metaJson ? (JSON.parse(r.metaJson) as Record<string, unknown>) : {};
    r.metaJson = JSON.stringify({ ...before, ...(JSON.parse(e.metaJson) as object) });
  }
  for (const l of e.addLinks)
    if (!r.links.some((x) => x.to === l.to && x.relation === l.relation)) r.links.push(l);
  r.version += 1;
  putRecord(ctx, user, r);
}

/** Moves a record to the other tier; false when it is already there. */
function moveTier(ctx: ApplyContext, user: string, r: MemoryRecord, m: TierMove): boolean {
  const cold = r.tier === 'cold';
  if (m.tier === 'cold') {
    if (cold || r.pinned) return false;
    r.text = m.text;
    r.tier = 'cold';
    r.coldSegment = m.segment;
    r.coldSha256 = m.sha256;
    ctx.txn.delete(vectorKey(ctx.command.tenant, user, r.id));
  } else {
    if (!cold) return false;
    r.text = m.text;
    r.tier = 'hot';
    r.coldSegment = '';
    r.coldSha256 = '';
    r.embeddingModel = m.vector.length > 0 ? m.modelId : '';
    if (m.vector.length > 0) putVector(ctx, user, r, m.vector);
  }
  putRecord(ctx, user, r);
  return true;
}

const isObject = (json: string): boolean => {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
};

function invalid(body: {
  evolve: MemoryEvolve[];
  tier: TierMove[];
  reembed: { vector: Uint8Array }[];
}): string {
  for (const e of body.evolve)
    if (e.metaJson !== '' && !isObject(e.metaJson)) return `meta of ${e.id} is not a JSON object`;
  for (const m of body.tier) {
    if (m.tier !== 'hot' && m.tier !== 'cold') return `tier ${m.tier} is not hot or cold`;
    if (m.text === '') return `tier move of ${m.id} has no text`;
    if (m.tier === 'cold' && (m.segment === '' || m.sha256 === ''))
      return `cold move of ${m.id} names no segment`;
    if (m.vector.length % 4 !== 0) return 'vector is not float32';
  }
  for (const r of body.reembed) if (r.vector.length % 4 !== 0) return 'vector is not float32';
  return '';
}

/**
 * `MemoryMaintain` (ADR-0033): a worker's lifecycle changes, checked first and
 * then applied with its checkpoint, its jobs and its own completion. Changes to
 * memories that were forgotten meanwhile are skipped.
 */
export const memoryMaintainHandler: ApplyHandler = {
  body: 'memoryMaintain',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryMaintain')
      throw new Error('memoryMaintain got another body');
    const b = ctx.command.body.value;
    const { tenant } = ctx.command;
    const refused = onBranch(ctx) ?? outsideRange(ctx, b.user);
    if (refused) return refused;
    const problem = invalid(b);
    if (problem) return errorResult('INVALID_ARGUMENT', problem);
    if (b.complete) {
      const completed = await completeJob(ctx, b.user, b.complete);
      if (completed.outcome.case === 'error') return completed;
    }
    for (const spec of b.enqueue) {
      const failed = enqueueJob(ctx, b.user, spec);
      if (failed) return failed;
    }
    if (b.nextTick) {
      const failed = enqueueJob(ctx, b.user, b.nextTick);
      if (failed) return failed;
    }
    const live = async (id: string) => {
      const r = await readRecord(ctx, tenant, b.user, id);
      return r && r.expiredAt === 0n ? r : undefined;
    };
    const changed = new Set<string>();
    let hot = 0;
    for (const e of b.evolve) {
      const r = await live(e.id);
      if (!r) continue;
      evolve(ctx, b.user, r, e);
      changed.add(r.id);
    }
    for (const m of b.tier) {
      const r = await live(m.id);
      if (!r || !moveTier(ctx, b.user, r, m)) continue;
      hot += m.tier === 'hot' ? 1 : -1;
      changed.add(r.id);
    }
    for (const x of b.reembed) {
      const r = await live(x.id);
      if (!r || r.tier === 'cold' || x.vector.length === 0) continue;
      r.embeddingModel = b.reembedModel;
      putRecord(ctx, b.user, r);
      putVector(ctx, b.user, r, x.vector);
      changed.add(r.id);
    }
    for (const p of b.pin) {
      const r = await live(p.id);
      if (!r || r.pinned === p.pinned) continue;
      r.pinned = p.pinned;
      putRecord(ctx, b.user, r);
      changed.add(r.id);
    }
    for (const s of b.entities) {
      const key = entityKey(tenant, b.user, s.entityId);
      const bytes = await ctx.txn.get(key);
      if (!bytes) continue;
      const entity = fromBinary(MemoryEntitySchema, bytes);
      entity.summary = s.summary;
      entity.summaryMentions = entity.mentionCount;
      ctx.txn.put(key, toBinary(MemoryEntitySchema, entity));
    }
    await updateLifecycle(ctx, tenant, b.user, (s) => {
      s.hot = Math.max(0, s.hot + hot);
      s.cold = Math.max(0, s.cold - hot);
      for (const spec of b.enqueue) markEnqueued(s, spec.kind, ctx.nowMs);
      if (b.checkpointWorker !== '') s.checkpoints[b.checkpointWorker] = b.checkpoint;
      if (b.reembedDone) {
        s.reembed = false;
        if (b.reembedModel !== '') s.embedModel = b.reembedModel;
      }
      if (b.tick) s.tickAtMs = b.nextTick ? b.nextTick.runAtMs || ctx.nowMs : 0n;
    });
    if (changed.size > 0) await bumpGeneration(ctx, tenant, b.user);
    return outcome([...changed]);
  },
};

/**
 * `MemoryRecallStats` (PLAN 13.7): each recalled memory's strength grows by the
 * spacing rule, from the days since its last recall (or creation).
 */
export const memoryRecallStatsHandler: ApplyHandler = {
  body: 'memoryRecallStats',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryRecallStats')
      throw new Error('memoryRecallStats got another body');
    const { user, ids } = ctx.command.body.value;
    const refused = onBranch(ctx) ?? outsideRange(ctx, user);
    if (refused) return refused;
    const done: string[] = [];
    for (const id of new Set(ids)) {
      const r = await readRecord(ctx, ctx.command.tenant, user, id);
      if (!r || r.expiredAt !== 0n) continue;
      const days = (Number(ctx.nowMs) - hlcMs(r.lastRecalledAt || r.createdAt)) / DAY_MS;
      r.strength = strengthAfterRecall(r.strength || 1, days);
      r.recallCount += 1;
      r.lastRecalledAt = ctx.version;
      putRecord(ctx, user, r);
      done.push(id);
    }
    return outcome(done);
  },
};
