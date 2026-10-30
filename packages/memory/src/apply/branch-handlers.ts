import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { dropDependents } from '@mindlog/cache';
import { decodeCount } from '@mindlog/index-text';
import type { CommandResult, EdgeWeight, MemoryBranch, MemoryRecord } from '@mindlog/proto';
import {
  MemoryBranchSchema,
  MemoryRecordSchema,
  MemoryEdgeSchema,
  MemoryEntitySchema,
  MemoryVectorSchema,
  NewMemorySchema,
} from '@mindlog/proto';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { Root } from '../keys.js';
import {
  branchKey,
  branchSpacePrefix,
  edgeKey,
  entityKey,
  generationKey,
  recordKey,
  vectorKey,
} from '../keys.js';
import { readRecord, rewriteRecord, supersedeFacts, writeConflict } from './conflict-writes.js';
import { bumpGeneration, forgetMemory, writeIndexTime, writeMemory } from './index-writes.js';
import { outcome, outsideRange } from './results.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export async function readBranch(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  name: string,
): Promise<MemoryBranch | undefined> {
  const bytes = await ctx.txn.get(branchKey(tenant, user, name));
  return bytes ? fromBinary(MemoryBranchSchema, bytes) : undefined;
}

export function writeBranch(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  b: MemoryBranch,
): void {
  ctx.txn.put(branchKey(tenant, user, b.name), toBinary(MemoryBranchSchema, b));
}

/** Where a memory command writes: main, or the open branch it names (ADR-0013). */
export type Space =
  | { readonly root: string; readonly branch?: undefined }
  | { readonly root: Root; readonly branch: MemoryBranch };

export async function spaceOf(
  ctx: ApplyContext,
  tenant: string,
  user: string,
): Promise<Space | CommandResult> {
  const name = ctx.command.branch;
  if (name === '' || name === 'main') return { root: user };
  const branch = await readBranch(ctx, tenant, user, name);
  if (branch?.status !== 'open') return errorResult('NOT_FOUND', `no open branch ${name}`);
  return { root: { user, branch: name }, branch };
}

/** Counts `n` more branch writes; an error result past the branch's limit. */
export function countWrites(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  branch: MemoryBranch,
  n: number,
): CommandResult | undefined {
  if (branch.writes + n > branch.maxWrites)
    return errorResult(
      'PAYLOAD_TOO_LARGE',
      `branch ${branch.name} holds at most ${String(branch.maxWrites)} memories`,
    );
  branch.writes += n;
  writeBranch(ctx, tenant, user, branch);
  return undefined;
}

/**
 * Changes a main memory as a branch sees it (ADR-0013): a copy of its record,
 * changed, masks it in the branch space. Only memories that existed and were
 * current at the fork are visible to the branch; false for others.
 */
export async function maskOnBranch(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  name: string,
  branch: MemoryBranch,
  id: string,
  change: (r: MemoryRecord) => void,
): Promise<boolean> {
  const root: Root = { user, branch: name };
  const copied = await readRecord(ctx, tenant, root, id);
  const main = copied ?? (await readRecord(ctx, tenant, user, id));
  if (!main || main.createdAt > branch.forkVersion) return false;
  if (!copied && main.expiredAt !== 0n && main.expiredAt <= branch.forkVersion) return false;
  const copy = create(MemoryRecordSchema, main);
  change(copy);
  copy.version += 1;
  ctx.txn.put(recordKey(tenant, root, id), toBinary(MemoryRecordSchema, copy));
  return true;
}

async function deleteSpace(ctx: ApplyContext, tenant: string, user: string, name: string) {
  const keys: Uint8Array[] = [];
  for await (const { key } of ctx.txn.scan(branchSpacePrefix(tenant, user, name))) keys.push(key);
  for (const key of keys) ctx.txn.delete(key);
}

/** `BranchCreate` (body 30): a branch that reads main as of this command. */
export const branchCreateHandler: ApplyHandler = {
  body: 'branchCreate',
  async apply(ctx) {
    if (ctx.command.body.case !== 'branchCreate') throw new Error('branchCreate got another body');
    const { user, name, maxWrites } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    if (!NAME.test(name) || name === 'main')
      return errorResult('INVALID_ARGUMENT', `invalid branch name ${name}`);
    if (await readBranch(ctx, tenant, user, name))
      return errorResult('ALREADY_EXISTS', `branch ${name} exists`);
    writeBranch(
      ctx,
      tenant,
      user,
      create(MemoryBranchSchema, {
        name,
        forkIndex: ctx.index,
        forkVersion: ctx.version,
        createdBy: ctx.command.principal,
        status: 'open',
        maxWrites,
      }),
    );
    return outcome([]);
  },
};

/** `BranchDrop` (body 32): closes the branch and deletes what it wrote. */
export const branchDropHandler: ApplyHandler = {
  body: 'branchDrop',
  async apply(ctx) {
    if (ctx.command.body.case !== 'branchDrop') throw new Error('branchDrop got another body');
    const { user, name } = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    const branch = await readBranch(ctx, tenant, user, name);
    if (branch?.status !== 'open') return errorResult('NOT_FOUND', `no open branch ${name}`);
    branch.status = 'dropped';
    branch.closedAt = ctx.version;
    writeBranch(ctx, tenant, user, branch);
    await deleteSpace(ctx, tenant, user, name);
    return outcome([]);
  },
};

/** Why a branch memory cannot be copied into main, if it cannot. */
async function cannotCopy(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  root: Root,
  id: string,
): Promise<CommandResult | undefined> {
  const record = await readRecord(ctx, tenant, root, id);
  if (!record || record.expiredAt !== 0n)
    return errorResult('INVALID_ARGUMENT', `branch has no memory ${id}`);
  if (await ctx.txn.get(recordKey(tenant, user, id)))
    return errorResult('ALREADY_EXISTS', `memory ${id} exists`);
  return undefined;
}

/** Copies a branch memory into main with its vector and entity mentions. */
async function copyToMain(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  root: Root,
  id: string,
  quarantine: boolean,
): Promise<void> {
  const record = await readRecord(ctx, tenant, root, id);
  if (!record) return;
  const row = await ctx.txn.get(vectorKey(tenant, root, id));
  const mentions = [];
  for (const e of record.entities) {
    const bytes = await ctx.txn.get(entityKey(tenant, root, e));
    if (bytes) mentions.push(fromBinary(MemoryEntitySchema, bytes));
  }
  record.branch = 'main';
  if (quarantine) record.trust = 'quarantined';
  await writeMemory(
    ctx,
    tenant,
    user,
    create(NewMemorySchema, {
      record,
      vector: row ? fromBinary(MemoryVectorSchema, row).vector : new Uint8Array(),
      mentions: mentions.map((m) => ({ name: m.name, type: m.type })),
    }),
  );
}

/** Sets an edge (both directions) to its merged state, creating missing entities from the branch. */
async function setEdge(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  root: Root,
  e: EdgeWeight,
): Promise<void> {
  for (const id of [e.src, e.dst]) {
    if (await ctx.txn.get(entityKey(tenant, user, id))) continue;
    const bytes = await ctx.txn.get(entityKey(tenant, root, id));
    if (!bytes) continue;
    const entity = fromBinary(MemoryEntitySchema, bytes);
    entity.mentionCount = 0;
    entity.createdAt = ctx.version;
    ctx.txn.put(entityKey(tenant, user, id), toBinary(MemoryEntitySchema, entity));
  }
  for (const key of [
    edgeKey(tenant, user, 'out', e.src, e.relation, e.dst),
    edgeKey(tenant, user, 'in', e.dst, e.relation, e.src),
  ]) {
    const bytes = await ctx.txn.get(key);
    const edge = bytes
      ? fromBinary(MemoryEdgeSchema, bytes)
      : create(MemoryEdgeSchema, { createdAt: ctx.version });
    edge.weight = e.weight;
    edge.memories = [...e.memories];
    ctx.txn.put(key, toBinary(MemoryEdgeSchema, edge));
  }
}

/**
 * `BranchMerge` (body 31): applies the leader's plan (`@mindlog/branching`)
 * if main has not moved since it was made: branch memories are copied into
 * main, changed main memories take their merged fields, edges their merged
 * weights, and conflicts are raised. The branch is closed and its space deleted.
 */
export const branchMergeHandler: ApplyHandler = {
  body: 'branchMerge',
  async apply(ctx) {
    if (ctx.command.body.case !== 'branchMerge') throw new Error('branchMerge got another body');
    const m = ctx.command.body.value;
    const { tenant } = ctx.command;
    const { user, name } = m;
    const moved = outsideRange(ctx, user);
    if (moved) return moved;
    const branch = await readBranch(ctx, tenant, user, name);
    if (branch?.status !== 'open') return errorResult('NOT_FOUND', `no open branch ${name}`);
    const generation = decodeCount(await ctx.txn.get(generationKey(tenant, user)));
    if (BigInt(generation) !== m.mainGeneration)
      return errorResult('CONFLICT', 'main changed since the merge was planned; plan it again');
    const root: Root = { user, branch: name };
    // Apply writes even when it fails, so everything is checked before the first write.
    for (const a of m.adds) {
      const failed = await cannotCopy(ctx, tenant, user, root, a.id);
      if (failed) return failed;
    }
    for (const a of m.adds) await copyToMain(ctx, tenant, user, root, a.id, a.quarantine);
    const forgotten: string[] = [];
    for (const f of m.records) {
      const r = await readRecord(ctx, tenant, user, f.id);
      if (!r || r.expiredAt !== 0n) continue;
      if (f.expired) {
        await forgetMemory(ctx, tenant, user, r, `merged from branch ${name}`);
        forgotten.push(r.id);
        continue;
      }
      const trustChanged = r.trust !== f.trust;
      if (!trustChanged && r.validTo === f.validTo) continue;
      r.trust = f.trust;
      r.validTo = f.validTo;
      await rewriteRecord(ctx, tenant, user, r, trustChanged);
    }
    await supersedeFacts(ctx, tenant, user, m.supersede);
    for (const e of m.edges) await setEdge(ctx, tenant, user, root, e);
    for (const c of m.conflicts) writeConflict(ctx, tenant, user, c);
    branch.status = 'merged';
    branch.closedAt = ctx.version;
    writeBranch(ctx, tenant, user, branch);
    await deleteSpace(ctx, tenant, user, name);
    await bumpGeneration(ctx, tenant, user);
    writeIndexTime(ctx, tenant, user);
    if (forgotten.length > 0) await dropDependents(ctx, tenant, user, forgotten);
    return outcome(m.adds.map((a) => a.id));
  },
};
