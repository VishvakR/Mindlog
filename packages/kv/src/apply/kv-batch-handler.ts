import { isKvTenant } from './kv-tenant.js';
import type { KvReply } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { KvCommandRegistry } from '../commands/registry.js';
import { applyKeyspace, outsideRange } from './apply-keyspace.js';
import { array, nil } from '../model/replies.js';
import { watchVersion } from '../model/watch.js';
import { kvResult } from './kv-write-handler.js';

/**
 * Applies `KvBatch` (MULTI/EXEC, PLAN 9.1): if any watched key changed since
 * WATCH the reply is nil and nothing runs; otherwise every queued command runs
 * in order within this one apply and the reply is the array of their replies.
 */
export function kvBatchHandler(registry: KvCommandRegistry): ApplyHandler {
  return {
    body: 'kvBatch',
    async apply(context) {
      const { command, txn } = context;
      if (command.body.case !== 'kvBatch')
        return errorResult('INTERNAL', 'expected a kvBatch body');
      if (!isKvTenant(command.tenant)) return errorResult('INVALID_ARGUMENT', 'invalid tenant');
      const batch = command.body.value;
      const keys = [
        ...batch.watches.map((w) => w.key),
        ...batch.writes.flatMap((w) => registry.keysOf(w.argv)),
      ];
      const moved = outsideRange(context, keys);
      if (moved) return moved;
      for (const watched of batch.watches) {
        if ((await watchVersion(txn, command.tenant, watched.key)) !== watched.version) {
          return kvResult(nil());
        }
      }
      const keyspace = applyKeyspace(context);
      const replies: KvReply[] = [];
      for (const write of batch.writes) replies.push(await registry.dispatch(keyspace, write.argv));
      return kvResult(array(replies));
    },
  };
}
