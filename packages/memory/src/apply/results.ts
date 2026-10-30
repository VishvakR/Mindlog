import { create } from '@bufbuild/protobuf';
import type { CommandResult } from '@mindlog/proto';
import { CommandResultSchema } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import { scopeKey } from '../keys.js';

export function outcome(ids: string[]): CommandResult {
  return create(CommandResultSchema, {
    outcome: { case: 'memory', value: { ids, count: ids.length } },
  });
}

export function outsideRange(ctx: ApplyContext, user: string): CommandResult | undefined {
  return inSpan(ctx.descriptor, scopeKey(ctx.command.tenant, user))
    ? undefined
    : errorResult('RANGE_MOVED', `scope is not in range ${String(ctx.descriptor.rangeId)}`);
}
