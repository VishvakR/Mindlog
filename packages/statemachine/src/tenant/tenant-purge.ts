import { create, fromBinary } from '@bufbuild/protobuf';
import { decodeKey, keyPrefix, prefixRange } from '@mindlog/core';
import { AuditRecordSchema, CommandResultSchema, KvReplySchema } from '@mindlog/proto';
import type { ApplyHandler } from '../apply/apply-handler.js';
import { errorResult } from '../apply/command-results.js';
import { SpanReader } from '../range/span.js';
import { rangeLocalPrefix } from '../system/system-keys.js';

/**
 * Where range-local rows name their tenant: `('r', rangeId, tag, …)` puts it at
 * tuple index 4 for the job (ADR-0017), KV expiry and dead-generation indexes
 * (ADR-0028), and at 3 for transaction locks and records (ADR-0030). The audit
 * outbox keeps it in the value.
 */
const TENANT_AT: Readonly<Record<string, number>> = {
  jobs: 4,
  expire: 4,
  deadgen: 4,
  'txn-lock': 3,
  'txn-commit': 3,
  'txn-rb': 3,
};

const removed = (n: number) =>
  create(CommandResultSchema, {
    outcome: {
      case: 'kv',
      value: create(KvReplySchema, { kind: { case: 'integer', value: BigInt(n) } }),
    },
  });

/**
 * Deletes one batch of a deleted tenant's rows from this range (PLAN 18.3):
 * every version of its keys in the span, physically, then the range-local
 * rows that name it. The result is how many rows went; 0 means none are left.
 */
export const tenantPurgeHandler: ApplyHandler = {
  body: 'tenantPurge',
  async apply(ctx) {
    const { body } = ctx.command;
    if (body.case !== 'tenantPurge') return errorResult('INTERNAL', 'wrong body');
    const { tenant, limit } = body.value;
    const prefix = keyPrefix(tenant);
    if (!prefix.ok) return errorResult('INVALID_ARGUMENT', prefix.error.message);
    let count = 0;
    const span = new SpanReader(ctx.raw.reader, ctx.descriptor);
    for await (const [key] of span.iterate(prefixRange(prefix.value), { limit })) {
      ctx.raw.batch.del(key);
      count++;
    }
    if (count >= limit) return removed(count);
    const local = prefixRange(rangeLocalPrefix(ctx.descriptor.rangeId));
    for await (const [key, value] of ctx.raw.reader.iterate(local)) {
      if (count >= limit) break;
      const decoded = decodeKey(key);
      if (!decoded.ok) continue;
      const { tuple } = decoded.value;
      const tag = tuple[2];
      const at = typeof tag === 'string' ? TENANT_AT[tag] : undefined;
      const named =
        at !== undefined
          ? tuple[at] === tenant
          : tag === 'audit' && fromBinary(AuditRecordSchema, value).tenant === tenant;
      if (named) {
        ctx.raw.batch.del(key);
        count++;
      }
    }
    return removed(count);
  },
};
