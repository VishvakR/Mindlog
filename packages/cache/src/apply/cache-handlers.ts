import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { decodeKey } from '@mindlog/core';
import type { CacheEntry, CommandResult } from '@mindlog/proto';
import { CacheEntrySchema, CommandResultSchema } from '@mindlog/proto';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import {
  cacheScopeKey,
  countKey,
  dependencyKey,
  dependencyPrefix,
  entryKey,
  entryPrefix,
} from '../keys.js';

const MAX_DEPENDENCIES = 100;

function outcome(ids: string[]): CommandResult {
  return create(CommandResultSchema, {
    outcome: { case: 'memory', value: { ids, count: ids.length } },
  });
}

function outsideRange(ctx: ApplyContext, user: string): CommandResult | undefined {
  return inSpan(ctx.descriptor, cacheScopeKey(ctx.command.tenant, user))
    ? undefined
    : errorResult('RANGE_MOVED', `scope is not in range ${String(ctx.descriptor.rangeId)}`);
}

async function readCount(ctx: ApplyContext, tenant: string, user: string): Promise<number> {
  const bytes = await ctx.txn.get(countKey(tenant, user));
  return bytes && bytes.byteLength === 4
    ? new DataView(bytes.buffer, bytes.byteOffset).getUint32(0)
    : 0;
}

function writeCount(ctx: ApplyContext, tenant: string, user: string, n: number): void {
  if (n <= 0) {
    ctx.txn.delete(countKey(tenant, user));
    return;
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, n);
  ctx.txn.put(countKey(tenant, user), bytes);
}

/** Deletes an entry and its dependency rows; the caller adjusts the count. */
function dropEntry(ctx: ApplyContext, tenant: string, user: string, entry: CacheEntry): void {
  ctx.txn.delete(entryKey(tenant, user, entry.id));
  for (const m of entry.memoryDeps) ctx.txn.delete(dependencyKey(tenant, user, m, entry.id));
}

async function dropIds(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  ids: Iterable<string>,
): Promise<string[]> {
  const dropped: string[] = [];
  for (const id of ids) {
    const bytes = await ctx.txn.get(entryKey(tenant, user, id));
    if (!bytes) continue;
    dropEntry(ctx, tenant, user, fromBinary(CacheEntrySchema, bytes));
    dropped.push(id);
  }
  if (dropped.length > 0)
    writeCount(ctx, tenant, user, (await readCount(ctx, tenant, user)) - dropped.length);
  return dropped;
}

/**
 * Drops the cache entries that depend on any of `memories`, in the caller's
 * batch (ADR-0012). Called by the apply of commands that change memories.
 * Returns the dropped entry ids.
 */
export async function dropDependents(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  memories: readonly string[],
): Promise<string[]> {
  const ids = new Set<string>();
  for (const m of memories)
    for await (const { key } of ctx.txn.scan(dependencyPrefix(tenant, user, m))) {
      const decoded = decodeKey(key);
      const id = decoded.ok ? decoded.value.tuple.at(-1) : undefined;
      if (typeof id === 'string') ids.add(id);
    }
  return dropIds(ctx, tenant, user, [...ids].sort());
}

/** Whether a memory exists and is not forgotten, read in the applying batch (the memory engine's). */
export type LiveMemory = (
  ctx: ApplyContext,
  tenant: string,
  user: string,
  memory: string,
) => Promise<boolean>;

/**
 * `CacheSet` (body 40): stores an entry and its dependency rows, first
 * evicting the scope's oldest entries (ids are ULIDs) beyond `maxEntries`.
 * A dependency that is missing or already forgotten fails the command, so an
 * entry never outlives a memory it uses whatever order the log puts them in.
 */
export const cacheSetHandler = (live: LiveMemory): ApplyHandler => ({
  body: 'cacheSet',
  async apply(ctx) {
    if (ctx.command.body.case !== 'cacheSet') throw new Error('cacheSet got another body');
    const { user, entry, maxEntries } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    if (!entry || entry.id === '' || entry.prompt === '' || entry.answer === '')
      return errorResult('INVALID_ARGUMENT', 'a cache entry needs an id, a prompt and an answer');
    if (entry.vector.byteLength % 4 !== 0)
      return errorResult('INVALID_ARGUMENT', 'vector is not float32');
    if (entry.memoryDeps.length > MAX_DEPENDENCIES || maxEntries < 1)
      return errorResult('INVALID_ARGUMENT', 'too many dependencies or no room for entries');
    if (await ctx.txn.get(entryKey(tenant, user, entry.id)))
      return errorResult('ALREADY_EXISTS', `cache entry ${entry.id} exists`);
    for (const m of entry.memoryDeps)
      if (!(await live(ctx, tenant, user, m)))
        return errorResult('NOT_FOUND', `memory ${m} does not exist or was forgotten`);
    const count = await readCount(ctx, tenant, user);
    if (count >= maxEntries) {
      const oldest: string[] = [];
      for await (const { value } of ctx.txn.scan(entryPrefix(tenant, user), {
        limit: count - maxEntries + 1,
      }))
        oldest.push(fromBinary(CacheEntrySchema, value).id);
      await dropIds(ctx, tenant, user, oldest);
    }
    const stored = create(CacheEntrySchema, { ...entry, createdAt: ctx.version });
    stored.memoryDeps = [...new Set(entry.memoryDeps)];
    ctx.txn.put(entryKey(tenant, user, stored.id), toBinary(CacheEntrySchema, stored));
    for (const m of stored.memoryDeps)
      ctx.txn.put(dependencyKey(tenant, user, m, stored.id), new Uint8Array());
    writeCount(ctx, tenant, user, (await readCount(ctx, tenant, user)) + 1);
    return outcome([stored.id]);
  },
});

/** `CacheInvalidate` (body 41): drops the listed entries; unknown ids are skipped. */
export const cacheInvalidateHandler: ApplyHandler = {
  body: 'cacheInvalidate',
  async apply(ctx) {
    if (ctx.command.body.case !== 'cacheInvalidate')
      throw new Error('cacheInvalidate got another body');
    const { user, ids } = ctx.command.body.value;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    return outcome(await dropIds(ctx, ctx.command.tenant, user, new Set(ids)));
  },
};
