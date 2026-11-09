import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { TupleElement } from '@mindlog/core';
import { KeyFamily, decodeKey, encodeKey, keyPrefix, prefixRange } from '@mindlog/core';
import type { AuditRecord, Command, CommandResult } from '@mindlog/proto';
import { AuditRecordSchema, CommandResultSchema, KvReplySchema } from '@mindlog/proto';
import type { KvReader } from '@mindlog/storage';
import type { ApplyHandler } from '../apply/apply-handler.js';
import { errorResult } from '../apply/command-results.js';
import type { RangeHooks } from '../range/range-commands.js';
import { inSpan } from '../range/span.js';
import { rangeLocalKey, rangeLocalPrefix } from '../system/system-keys.js';

const DAY_MS = 86_400_000n;

/** Whole days since the epoch; the audit family's split boundary, so it never stops splitting. */
export const auditDay = (ms: bigint): bigint => ms / DAY_MS;
const dayElement = (day: bigint): string => `audit-${String(day)}`;

/** `tenant·s·('audit-<day>', atMs, id)` (PLAN 18.5), bucketed by day. */
export function auditKey(tenant: string, atMs: bigint, id: string): Uint8Array {
  const tuple: TupleElement[] = [dayElement(auditDay(atMs)), atMs, id];
  const key = encodeKey({ tenant, family: KeyFamily.SYSTEM, tuple });
  if (!key.ok) throw new RangeError(key.error.message);
  return key.value;
}

export function auditDayPrefix(tenant: string, day: bigint): Uint8Array {
  const prefix = keyPrefix(tenant, KeyFamily.SYSTEM, [dayElement(day)]);
  if (!prefix.ok) throw new RangeError(prefix.error.message);
  return prefix.value;
}

/** Pending audit records of a range, written atomically with the command they describe. */
export const auditOutboxPrefix = (rangeId: bigint): Uint8Array =>
  rangeLocalPrefix(rangeId, 'audit');
const outboxKey = (rangeId: bigint, version: bigint, origin: bigint): Uint8Array =>
  rangeLocalKey(rangeId, 'audit', version, origin);

/** The user or collection a security-relevant command acted on; undefined for everything else. */
function auditedResource(command: Command): string | undefined {
  const { body } = command;
  switch (body.case) {
    case 'memoryForget':
    case 'conflictResolve':
    case 'memoryTrust':
    case 'branchMerge':
    case 'branchDrop':
      return `user:${body.value.user}`;
    case 'schemaChange':
      return `collection:${body.value.collection}`;
    case 'tenantPurge':
      return `tenant:${body.value.tenant}`;
    default:
      return undefined;
  }
}

/** The audit row of a command, if it needs one; decided only from the command and its result. */
export function auditRecordOf(
  command: Command,
  result: CommandResult,
  rangeId: bigint,
  index: bigint,
  atMs: bigint,
): AuditRecord | undefined {
  const resource = auditedResource(command);
  if (resource === undefined || command.body.case === undefined) return undefined;
  return create(AuditRecordSchema, {
    tenant: command.tenant,
    id: `${String(rangeId)}-${String(index)}`,
    principal: command.principal,
    actor: command.actor,
    action: command.body.case,
    resource,
    requestId: command.requestId,
    ok: result.outcome.case !== 'error',
    atMs,
  });
}

/** Writes a command's audit row into its range's outbox. */
export function writeAuditOutbox(
  batch: { put(key: Uint8Array, value: Uint8Array): void },
  rangeId: bigint,
  version: bigint,
  record: AuditRecord,
): void {
  batch.put(outboxKey(rangeId, version, rangeId), toBinary(AuditRecordSchema, record));
}

export interface PendingAudit {
  readonly key: Uint8Array;
  readonly version: bigint;
  readonly record: AuditRecord;
}

const OK = () =>
  create(CommandResultSchema, {
    outcome: {
      case: 'kv',
      value: create(KvReplySchema, { kind: { case: 'simple', value: 'OK' } }),
    },
  });

/** Puts drained records in place; a replayed batch writes the same keys. */
export const auditAppendHandler: ApplyHandler = {
  body: 'auditAppend',
  apply(ctx) {
    const { body } = ctx.command;
    if (body.case !== 'auditAppend') return Promise.resolve(errorResult('INTERNAL', 'wrong body'));
    for (const record of body.value.records) {
      const key = auditKey(record.tenant, record.atMs, record.id);
      if (!inSpan(ctx.descriptor, key))
        return Promise.resolve(
          errorResult('RANGE_MOVED', `audit day is not in range ${String(ctx.descriptor.rangeId)}`),
        );
      ctx.txn.put(key, toBinary(AuditRecordSchema, record));
    }
    return Promise.resolve(OK());
  },
};

/** Deletes a tenant's audit day past its retention (CLAUDE.md rule 8). */
export const auditExpireHandler: ApplyHandler = {
  body: 'auditExpire',
  async apply(ctx) {
    const { body } = ctx.command;
    if (body.case !== 'auditExpire') return errorResult('INTERNAL', 'wrong body');
    const prefix = auditDayPrefix(body.value.tenant, body.value.day);
    if (!inSpan(ctx.descriptor, prefix)) return errorResult('RANGE_MOVED', 'audit day moved');
    const seen: Uint8Array[] = [];
    for await (const { key } of ctx.txn.scan(prefix, { limit: body.value.limit })) seen.push(key);
    for (const key of seen) ctx.txn.delete(key);
    return OK();
  },
};

/** Removes outbox rows the drainer has placed. Raw deletes: range-local, and not versioned. */
export const auditOutboxAckHandler: ApplyHandler = {
  body: 'auditOutboxAck',
  async apply(ctx) {
    const { body } = ctx.command;
    if (body.case !== 'auditOutboxAck') return errorResult('INTERNAL', 'wrong body');
    const range = prefixRange(auditOutboxPrefix(ctx.descriptor.rangeId));
    const end = outboxKey(ctx.descriptor.rangeId, body.value.throughVersion + 1n, 0n);
    for await (const [key] of ctx.raw.reader.iterate({ start: range.start, end }))
      ctx.raw.batch.del(key);
    return OK();
  },
};

/** The oldest pending rows of a range, for the drainer. */
export async function readAuditOutbox(
  reader: KvReader,
  rangeId: bigint,
  limit: number,
): Promise<PendingAudit[]> {
  const out: PendingAudit[] = [];
  for await (const [key, value] of reader.iterate(prefixRange(auditOutboxPrefix(rangeId)), {
    limit,
  })) {
    const decoded = decodeKey(key);
    const version = decoded.ok ? decoded.value.tuple[3] : undefined;
    if (typeof version !== 'bigint') throw new Error('malformed audit outbox key');
    out.push({ key, version, record: fromBinary(AuditRecordSchema, value) });
  }
  return out;
}

/** Merges keep the right range's pending rows; a split leaves them on the left, which drains them. */
export const auditRangeHooks: RangeHooks = {
  split: () => Promise.resolve(),
  async merge(raw, left, right) {
    const prefix = auditOutboxPrefix(right);
    const moved = prefix.length;
    for await (const [key, value] of raw.reader.iterate(prefixRange(prefix))) {
      const target = auditOutboxPrefix(left);
      const out = new Uint8Array(target.length + key.length - moved);
      out.set(target);
      out.set(key.subarray(moved), target.length);
      raw.batch.put(out, value);
    }
  },
};
