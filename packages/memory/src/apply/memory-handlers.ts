import { create, fromBinary } from '@bufbuild/protobuf';
import type { LiveMemory } from '@mindlog/cache';
import { dropDependents } from '@mindlog/cache';
import { completeJob, enqueueJob } from '@mindlog/jobs';
import type { CommandResult } from '@mindlog/proto';
import { CommandResultSchema, MemoryRecordSchema } from '@mindlog/proto';
import { decodeKey } from '@mindlog/core';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import { derivedPrefix, recordKey, scopeKey, sourceRefPrefix } from '../keys.js';
import { MEMORY_KINDS } from '../types.js';
import {
  bumpGeneration,
  forgetMemory,
  writeEdge,
  writeIndexTime,
  writeMemory,
} from './index-writes.js';
import { supersedeFacts, writeConflict } from './conflict-writes.js';

const KINDS = new Set<string>(MEMORY_KINDS);

export function outcome(ids: string[]): CommandResult {
  return create(CommandResultSchema, {
    outcome: { case: 'memory', value: { ids, count: ids.length } },
  });
}

export function outsideRange(ctx: ApplyContext, user: string): CommandResult | undefined {
  return inSpan(ctx.descriptor, scopeKey(ctx.command.tenant, user))
    ? undefined
    : errorResult('RANGE_MOVED', `scope is not in range ${String(ctx.descriptor.rangeId)}`);
}

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
    for (const m of commit.memories) {
      const r = m.record;
      if (!r || r.id === '' || r.user !== commit.user || r.text === '' || !KINDS.has(r.kind))
        return errorResult('INVALID_ARGUMENT', `invalid memory ${r?.id ?? ''}`);
      if (m.vector.length % 4 !== 0)
        return errorResult('INVALID_ARGUMENT', 'vector is not float32');
      if (await ctx.txn.get(recordKey(tenant, commit.user, r.id)))
        return errorResult('ALREADY_EXISTS', `memory ${r.id} exists`);
    }
    const newIds = new Set(commit.memories.map((m) => m.record?.id));
    for (const c of commit.conflicts)
      if (c.id === '' || c.a === '' || !newIds.has(c.b))
        return errorResult('INVALID_ARGUMENT', `invalid conflict ${c.id}`);
    if (commit.complete) {
      const completed = await completeJob(ctx, commit.user, commit.complete);
      if (completed.outcome.case === 'error') return completed;
    }
    for (const spec of commit.enqueue) {
      const failed = enqueueJob(ctx, commit.user, spec);
      if (failed) return failed;
    }
    const ids: string[] = [];
    for (const m of commit.memories) ids.push(await writeMemory(ctx, tenant, commit.user, m));
    for (const e of commit.edges) await writeEdge(ctx, tenant, commit.user, e);
    await supersedeFacts(ctx, tenant, commit.user, commit.supersede);
    for (const c of commit.conflicts) writeConflict(ctx, tenant, commit.user, c);
    await bumpGeneration(ctx, tenant, commit.user);
    writeIndexTime(ctx, tenant, commit.user);
    return outcome(ids);
  },
};

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
    const targets = new Set(ids);
    if (sourceRef !== '') {
      const tainted = await taintedBy(ctx, tenant, user, sourceRef, cascadeLimit);
      if (!tainted)
        return errorResult(
          'PAYLOAD_TOO_LARGE',
          `more than ${String(cascadeLimit)} memories derive from ${sourceRef}`,
        );
      for (const id of tainted) targets.add(id);
    }
    const forgotten: string[] = [];
    for (const id of targets) {
      const bytes = await ctx.txn.get(recordKey(tenant, user, id));
      if (!bytes) continue;
      const record = fromBinary(MemoryRecordSchema, bytes);
      if (record.expiredAt !== 0n) continue;
      await forgetMemory(ctx, tenant, user, record, reason);
      forgotten.push(id);
    }
    if (forgotten.length > 0) {
      await bumpGeneration(ctx, tenant, user);
      await dropDependents(ctx, tenant, user, forgotten);
      writeIndexTime(ctx, tenant, user);
    }
    return outcome(forgotten);
  },
};
