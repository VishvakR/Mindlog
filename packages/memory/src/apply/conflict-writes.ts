import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { MemoryConflict, MemoryRecord, Supersede } from '@mindlog/proto';
import { MemoryConflictSchema, MemoryRecordSchema, MemoryVectorSchema } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import type { Root } from '../keys.js';
import { conflictKey, openConflictKey, recordKey, vectorKey, versionKey } from '../keys.js';

// Writes of conflict detection and review (ADR-0015), inside a memory command's apply.

export async function readRecord(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  id: string,
): Promise<MemoryRecord | undefined> {
  const bytes = await ctx.txn.get(recordKey(tenant, user, id));
  return bytes ? fromBinary(MemoryRecordSchema, bytes) : undefined;
}

/** Stores a changed record as its next version; the vector row follows a trust change. */
export async function rewriteRecord(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  record: MemoryRecord,
  trustChanged: boolean,
): Promise<void> {
  // Main keeps every earlier version for the history view (ADR-0033); branches are short-lived.
  if (typeof user === 'string') {
    const before = await ctx.txn.get(recordKey(tenant, user, record.id));
    if (before) ctx.txn.put(versionKey(tenant, user, record.id, record.version), before);
  }
  record.version += 1;
  ctx.txn.put(recordKey(tenant, user, record.id), toBinary(MemoryRecordSchema, record));
  if (!trustChanged) return;
  const bytes = await ctx.txn.get(vectorKey(tenant, user, record.id));
  if (!bytes) return;
  const row = fromBinary(MemoryVectorSchema, bytes);
  row.trust = record.trust;
  ctx.txn.put(vectorKey(tenant, user, record.id), toBinary(MemoryVectorSchema, row));
}

/** Ends the validity of current facts that newer ones replace; others are skipped. */
export async function supersedeFacts(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  list: readonly Supersede[],
): Promise<void> {
  for (const s of list) {
    const r = await readRecord(ctx, tenant, user, s.id);
    if (!r || r.expiredAt !== 0n || (r.validTo !== 0n && r.validTo <= s.validTo)) continue;
    r.validTo = s.validTo;
    await rewriteRecord(ctx, tenant, user, r, false);
  }
}

export function writeConflict(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  conflict: MemoryConflict,
): void {
  const c = create(MemoryConflictSchema, conflict);
  if (c.detectedAt === 0n) c.detectedAt = ctx.version;
  if (c.status === 'resolved' && c.resolvedAt === 0n) c.resolvedAt = ctx.version;
  ctx.txn.put(conflictKey(tenant, user, c.id), toBinary(MemoryConflictSchema, c));
  if (c.status === 'open') ctx.txn.put(openConflictKey(tenant, user, c.id), new Uint8Array());
  else ctx.txn.delete(openConflictKey(tenant, user, c.id));
}

export async function readConflict(
  ctx: ApplyContext,
  tenant: string,
  user: Root,
  id: string,
): Promise<MemoryConflict | undefined> {
  const bytes = await ctx.txn.get(conflictKey(tenant, user, id));
  return bytes ? fromBinary(MemoryConflictSchema, bytes) : undefined;
}
