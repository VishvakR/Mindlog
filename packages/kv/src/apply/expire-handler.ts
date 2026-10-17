import { isKvTenant } from './kv-tenant.js';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { expiryIndexKey } from '../model/kv-keys.js';
import { applyKeyspace, outsideRange } from './apply-keyspace.js';
import { integer } from '../model/replies.js';
import { kvResult } from './kv-write-handler.js';

/**
 * Applies `Expire` commands from the leader's expiry job. Each key is deleted
 * only if its stored expiry has passed at the command's time, so a key
 * rewritten in the meantime survives; stale index entries are dropped.
 */
export const expireHandler: ApplyHandler = {
  body: 'expire',
  async apply(context) {
    const { command, raw, descriptor } = context;
    if (command.body.case !== 'expire') return errorResult('INTERNAL', 'expected an expire body');
    if (!isKvTenant(command.tenant)) return errorResult('INVALID_ARGUMENT', 'invalid tenant');
    const { keys } = command.body.value;
    const moved = outsideRange(
      context,
      keys.map((k) => k.key),
    );
    if (moved) return moved;
    const keyspace = applyKeyspace(context);
    let expired = 0;
    for (const { key, expireAtMs } of keys) {
      if (await keyspace.expireIfDue(key)) expired++;
      else raw.batch.del(expiryIndexKey(descriptor.rangeId, expireAtMs, command.tenant, key));
    }
    return kvResult(integer(expired));
  },
};
