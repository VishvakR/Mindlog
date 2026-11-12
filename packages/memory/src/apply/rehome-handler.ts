import { fromBinary, toBinary } from '@bufbuild/protobuf';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { MemoryRecordSchema } from '@mindlog/proto';
import { forgottenKey, recordKey } from '../keys.js';
import { updateLifecycle } from '../lifecycle.js';
import { MAX_CLUSTERS, baseUser } from '../split/clusters.js';
import { bumpGeneration, unindexMemory, writeMemory } from './index-writes.js';
import { outcome, outsideRange } from './results.js';

/**
 * `MemoryRehome` (ADR-0039), on one scope of a split: sets the root's
 * clusters, takes in memories copied from another cluster with their original
 * stamps, or marks memories as moved away (unindexed, record kept for
 * history). Each part is idempotent, so a split interrupted anywhere just
 * runs its batch again. It raises no change events: nothing new happened.
 */
export const memoryRehomeHandler: ApplyHandler = {
  body: 'memoryRehome',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryRehome') throw new Error('memoryRehome got another body');
    const r = ctx.command.body.value;
    const { tenant } = ctx.command;
    const moved = outsideRange(ctx, r.user);
    if (moved) return moved;
    if (r.setLayout) {
      if (baseUser(r.user) !== r.user)
        return errorResult('INVALID_ARGUMENT', 'only a root scope holds the clusters');
      if (r.layout.length > MAX_CLUSTERS)
        return errorResult('INVALID_ARGUMENT', `at most ${String(MAX_CLUSTERS)} clusters`);
      await updateLifecycle(ctx, tenant, r.user, (s) => {
        s.clusters = r.layout;
      });
    }
    const ids: string[] = [];
    for (const copy of r.copies) {
      const record = copy.record;
      if (!record || record.id === '')
        return errorResult('INVALID_ARGUMENT', 'a copy has no record');
      if (await ctx.txn.get(recordKey(tenant, r.user, record.id))) continue;
      // Forgotten here while it was on its way: it stays forgotten.
      if (await ctx.txn.get(forgottenKey(tenant, r.user, record.id))) continue;
      record.user = r.user;
      ids.push(await writeMemory(ctx, tenant, r.user, copy, true));
    }
    for (const id of r.moved) {
      const bytes = await ctx.txn.get(recordKey(tenant, r.user, id));
      if (!bytes) continue;
      const record = fromBinary(MemoryRecordSchema, bytes);
      if (record.movedTo !== '' || record.expiredAt !== 0n) continue;
      await unindexMemory(ctx, tenant, r.user, record);
      record.movedTo = r.movedTo;
      ctx.txn.put(recordKey(tenant, r.user, id), toBinary(MemoryRecordSchema, record));
      ids.push(id);
    }
    if (r.copies.length > 0 || r.moved.length > 0) await bumpGeneration(ctx, tenant, r.user);
    return outcome(ids);
  },
};
