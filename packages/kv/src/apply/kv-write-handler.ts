import { create } from '@bufbuild/protobuf';
import { isKvTenant } from './kv-tenant.js';
import type { KvReply } from '@mindlog/proto';
import { CommandResultSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import type { KvCommandRegistry } from '../commands/registry.js';
import { applyKeyspace, outsideRange } from './apply-keyspace.js';

export const kvResult = (reply: KvReply) =>
  create(CommandResultSchema, { outcome: { case: 'kv', value: reply } });

/**
 * Applies `KvWrite`: re-executes the client's argv against the latest state
 * with the command's time and index-seeded randomness (ADR-0021).
 */
export function kvWriteHandler(registry: KvCommandRegistry): ApplyHandler {
  return {
    body: 'kvWrite',
    async apply(context) {
      const { command } = context;
      if (command.body.case !== 'kvWrite')
        return errorResult('INTERNAL', 'expected a kvWrite body');
      if (!isKvTenant(command.tenant)) return errorResult('INVALID_ARGUMENT', 'invalid tenant');
      const { argv } = command.body.value;
      const moved = outsideRange(context, registry.keysOf(argv));
      if (moved) return moved;
      return kvResult(await registry.dispatch(applyKeyspace(context), argv));
    },
  };
}
