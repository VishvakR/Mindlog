import { isUserTenant } from '@mindlog/core';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { expiryIndexKey } from '../model/kv-keys.js';
import { Keyspace } from '../model/keyspace.js';
import { integer } from '../model/replies.js';
import { kvResult } from './kv-write-handler.js';

/**
 * Applies `Expire` commands from the leader's expiry job. Each key is deleted
 * only if its stored expiry has passed at the command's time, so a key
 * rewritten in the meantime survives; stale index entries are dropped.
 */
export const expireHandler: ApplyHandler = {
  body: 'expire',
  async apply({ command, txn, index, nowMs }) {
    if (command.body.case !== 'expire') return errorResult('INTERNAL', 'expected an expire body');
    if (!isUserTenant(command.tenant)) return errorResult('INVALID_ARGUMENT', 'invalid tenant');
    const keyspace = new Keyspace({ tenant: command.tenant, nowMs, view: txn, writer: txn, index });
    let expired = 0;
    for (const { key, expireAtMs } of command.body.value.keys) {
      if (await keyspace.expireIfDue(key)) expired++;
      else txn.delete(expiryIndexKey(expireAtMs, command.tenant, key));
    }
    return kvResult(integer(expired));
  },
};
