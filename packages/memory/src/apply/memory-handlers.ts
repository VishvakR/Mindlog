import { fromBinary } from '@bufbuild/protobuf';
import type { LiveMemory } from '@mindlog/cache';
import { dropDependents } from '@mindlog/cache';
import { completeJob, enqueueJob } from '@mindlog/jobs';
import { countWrites, maskOnBranch, spaceOf } from './branch-handlers.js';
import { readRecord } from './conflict-writes.js';
import { outcome, outsideRange } from './results.js';
import type { JobSpec, MemoryCommit, MemoryRecord } from '@mindlog/proto';
import { MemoryRecordSchema } from '@mindlog/proto';
import { decodeKey } from '@mindlog/core';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { derivedPrefix, recordKey, sourceRefPrefix } from '../keys.js';
import { MEMORY_KINDS } from '../types.js';
import { LIFECYCLE_JOBS, updateLifecycle } from '../lifecycle.js';
import {
  bumpGeneration,
  forgetMemory,
  writeEdge,
  writeIndexTime,
  writeMemory,
} from './index-writes.js';
import { supersedeFacts, writeConflict } from './conflict-writes.js';

const KINDS = new Set<string>(MEMORY_KINDS);

/** A memory record exists and is not forgotten (for `cacheSetHandler`, ADR-0012). */
export const liveMemory: LiveMemory = async (ctx, tenant, user, id) => {
  const bytes = await ctx.txn.get(recordKey(tenant, user, id));
  return bytes !== undefined && fromBinary(MemoryRecordSchema, bytes).expiredAt === 0n;
};

/**
 * `MemoryCommit` (ADR-0032): validates everything first, then completes the
 * job that produced the memories, enqueues new jobs and writes the memories
 * with their indexes, the facts they supersede and the conflicts they raise
 * (ADR-0015), all in this command's one batch.
 */
export const memoryCommitHandler: ApplyHandler = {
  body: 'memoryCommit',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryCommit') throw new Error('memoryCommit got another body');
    const commit = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, commit.user);
    if (moved) return moved;
    const space = await spaceOf(ctx, tenant, commit.user);
    if (!('root' in space)) return space;
    const { root, branch } = space;
    if (
      branch &&
      (commit.conflicts.length > 0 ||
        commit.supersede.length > 0 ||
        commit.enqueue.length > 0 ||
        commit.complete ||
        commit.tick ||
        commit.reembed)
    )
      return errorResult('INVALID_ARGUMENT', 'a branch commit carries memories and edges only');
    for (const m of commit.memories) {
      const r = m.record;
      if (!r || r.id === '' || r.user !== commit.user || r.text === '' || !KINDS.has(r.kind))
        return errorResult('INVALID_ARGUMENT', `invalid memory ${r?.id ?? ''}`);
      if (m.vector.length % 4 !== 0)
        return errorResult('INVALID_ARGUMENT', 'vector is not float32');
      if (await ctx.txn.get(recordKey(tenant, root, r.id)))
        return errorResult('ALREADY_EXISTS', `memory ${r.id} exists`);
    }
    const newIds = new Set(commit.memories.map((m) => m.record?.id));
    for (const c of commit.conflicts)
      if (c.id === '' || c.a === '' || !newIds.has(c.b))
        return errorResult('INVALID_ARGUMENT', `invalid conflict ${c.id}`);
    if (branch) {
      const full = countWrites(ctx, tenant, commit.user, branch, commit.memories.length);
      if (full) return full;
    }
    if (commit.complete) {
      const completed = await completeJob(ctx, commit.user, commit.complete);
      if (completed.outcome.case === 'error') return completed;
    }
    for (const spec of commit.enqueue) {
      const failed = enqueueJob(ctx, commit.user, spec);
      if (failed) return failed;
    }
    const ids: string[] = [];
    for (const m of commit.memories) {
      if (branch && m.record) m.record.branch = branch.name;
      ids.push(await writeMemory(ctx, tenant, root, m));
    }
    for (const e of commit.edges) await writeEdge(ctx, tenant, root, e);
    await supersedeFacts(ctx, tenant, commit.user, commit.supersede);
    for (const c of commit.conflicts) writeConflict(ctx, tenant, commit.user, c);
    await bumpGeneration(ctx, tenant, root);
    if (!branch) {
      writeIndexTime(ctx, tenant, commit.user);
      await noteCommit(ctx, commit);
    }
    return outcome(ids);
  },
};

/** Lifecycle state after a main commit (ADR-0033): trigger counts, the embed model, the tick. */
async function noteCommit(ctx: ApplyContext, commit: MemoryCommit): Promise<void> {
  const { tenant } = ctx.command;
  let tick: JobSpec | undefined;
  // What consolidation wrote (themes, learned context) must not trigger consolidation again.
  const organic = commit.memories.filter((m) => m.record?.source?.type !== 'consolidation');
  const organicIds = new Set(organic.map((m) => m.record?.id));
  await updateLifecycle(ctx, tenant, commit.user, (s) => {
    const n = organic.length;
    if (n > 0) s.lastWriteMs = ctx.nowMs;
    // Graph size counts entity mentions and edge statements of organic memories.
    s.graphSize +=
      organic.reduce((sum, m) => sum + m.mentions.length, 0) +
      commit.edges.filter((e) => organicIds.has(e.memoryId)).length;
    // The daily sleep-time run counts from the scope's first commit, not from the epoch.
    if (!(LIFECYCLE_JOBS.sleep in s.lastRunMs)) s.lastRunMs[LIFECYCLE_JOBS.sleep] = ctx.nowMs;
    s.writesSinceSleep += n;
    s.writesSinceEvolve += n;
    for (const m of commit.memories) {
      const model = m.vector.length > 0 ? (m.record?.embeddingModel ?? '') : '';
      if (model === '' || model === s.embedModel) continue;
      if (s.embedModel !== '') s.reembed = true;
      s.embedModel = model;
    }
    if (commit.reembed) s.reembed = true;
    if (commit.tick && s.tickAtMs === 0n) {
      tick = commit.tick;
      s.tickAtMs = tick.runAtMs === 0n ? ctx.nowMs : tick.runAtMs;
    }
  });
  // In range: the commit's scope key was checked, and the job lives in the same scope.
  if (tick) enqueueJob(ctx, commit.user, tick);
}

/** Ids under a key prefix whose last element is the id. */
async function* idsUnder(ctx: ApplyContext, prefix: Uint8Array): AsyncGenerator<string> {
  for await (const { key } of ctx.txn.scan(prefix)) {
    const decoded = decodeKey(key);
    const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
    if (typeof id === 'string') yield id;
  }
}

/**
 * The taint cascade (PLAN 13.4): memories from a source and, transitively,
 * those derived from them; undefined past `limit`.
 */
async function taintedBy(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  ref: string,
  limit: number,
): Promise<Set<string> | undefined> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for await (const id of idsUnder(ctx, sourceRefPrefix(tenant, user, ref))) queue.push(id);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (seen.size > limit) return undefined;
    for await (const child of idsUnder(ctx, derivedPrefix(tenant, user, id))) queue.push(child);
  }
  return seen;
}

/**
 * `MemoryForget`: expires the current ones among `ids`, plus everything a
 * tainted source led to; unknown or forgotten ids are skipped. Cache entries
 * depending on them are dropped in the same batch (ADR-0012).
 */
export const memoryForgetHandler: ApplyHandler = {
  body: 'memoryForget',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryForget') throw new Error('memoryForget got another body');
    const { user, ids, reason, sourceRef, cascadeLimit } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    const space = await spaceOf(ctx, tenant, user);
    if (!('root' in space)) return space;
    const { root, branch } = space;
    const targets = new Set(ids);
    if (sourceRef !== '') {
      if (branch) return errorResult('INVALID_ARGUMENT', 'forget a source on main');
      const tainted = await taintedBy(ctx, tenant, user, sourceRef, cascadeLimit);
      if (!tainted)
        return errorResult(
          'PAYLOAD_TOO_LARGE',
          `more than ${String(cascadeLimit)} memories derive from ${sourceRef}`,
        );
      for (const id of tainted) targets.add(id);
    }
    // Each masked main memory is a branch write; check the limit before writing anything.
    if (branch && branch.writes + targets.size > branch.maxWrites)
      return errorResult(
        'PAYLOAD_TOO_LARGE',
        `branch ${branch.name} holds at most ${String(branch.maxWrites)} memories`,
      );
    let masked = 0;
    const forgotten: string[] = [];
    for (const id of targets) {
      const record = await readRecord(ctx, tenant, root, id);
      const own = branch === undefined || (record && !(await readRecord(ctx, tenant, user, id)));
      if (own) {
        if (!record || record.expiredAt !== 0n) continue;
        await forgetMemory(ctx, tenant, root, record, reason);
        forgotten.push(id);
        continue;
      }
      // A main memory, forgotten only as the branch sees it.
      if (record && record.expiredAt !== 0n) continue;
      const expire = (r: MemoryRecord) => {
        r.expiredAt = ctx.version;
        r.forgetReason = reason;
      };
      if (await maskOnBranch(ctx, tenant, user, branch.name, branch, id, expire)) {
        forgotten.push(id);
        masked++;
      }
    }
    if (branch && masked > 0) countWrites(ctx, tenant, user, branch, masked);
    if (forgotten.length > 0) {
      await bumpGeneration(ctx, tenant, root);
      if (!branch) {
        await dropDependents(ctx, tenant, user, forgotten);
        writeIndexTime(ctx, tenant, user);
      }
    }
    return outcome(forgotten);
  },
};
