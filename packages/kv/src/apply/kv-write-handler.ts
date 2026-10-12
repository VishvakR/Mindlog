import { create } from '@bufbuild/protobuf';
import { isKvTenant } from './kv-tenant.js';
import type { KvReply } from '@mindlog/proto';
import { CommandResultSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { KvCommandRegistry } from '../commands/registry.js';
import { Keyspace } from '../model/keyspace.js';

export const kvResult = (reply: KvReply) =>
  create(CommandResultSchema, { outcome: { case: 'kv', value: reply } });

/**
 * Applies `KvWrite`: re-executes the client's argv against the latest state
 * with the command's time and index-seeded randomness (ADR-0021).
 */
export function kvWriteHandler(registry: KvCommandRegistry): ApplyHandler {
  return {
    body: 'kvWrite',
    async apply({ command, txn, index, nowMs, random }) {
      if (command.body.case !== 'kvWrite')
        return errorResult('INTERNAL', 'expected a kvWrite body');
      if (!isKvTenant(command.tenant)) return errorResult('INVALID_ARGUMENT', 'invalid tenant');
      const keyspace = new Keyspace({
        tenant: command.tenant,
        nowMs,
        view: txn,
        writer: txn,
        index,
        random,
      });
      return kvResult(await registry.dispatch(keyspace, command.body.value.argv));
    },
  };
}
