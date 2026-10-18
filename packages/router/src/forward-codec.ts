import { create } from '@bufbuild/protobuf';
import type { ClockSync, MindlogError, Result } from '@mindlog/core';

import type { ExecuteRequest, KvReply } from '@mindlog/proto';
import { ExecuteRequestSchema } from '@mindlog/proto';
import type { Caller, RangeCall } from '@mindlog/services';
import type { KvForwarder } from '@mindlog/transport';
import type { ForwardCall } from './forward-call.js';

/** Wire form of a call to forward (ADR-0029). */
export function toRequest(
  rangeId: bigint,
  caller: Caller,
  call: RangeCall,
  hlc: bigint,
  fromAddress: string,
): ExecuteRequest {
  const requestId = call.kind === 'watch' ? undefined : call.requestId;
  const base = {
    ...(requestId ? { requestId } : {}),
    rangeId,
    tenant: caller.tenant,
    principal: caller.principal,
    hlc,
    fromAddress,
  };
  const kind =
    call.kind === 'command'
      ? { case: 'command' as const, value: { argv: [...call.argv] } }
      : call.kind === 'batch'
        ? {
            case: 'batch' as const,
            value: {
              writes: call.writes.map((argv) => ({ argv: [...argv] })),
              watches: [...call.watches],
            },
          }
        : { case: 'watch' as const, value: { keys: [...call.keys] } };
  return create(ExecuteRequestSchema, { ...base, call: kind });
}

/** The call a request carries, or `undefined` for an empty one. */
export function fromRequest(
  request: ExecuteRequest,
): { rangeId: bigint; caller: Caller; call: RangeCall } | undefined {
  const caller = { tenant: request.tenant, principal: request.principal };
  const c = request.call;
  const id = request.requestId.length > 0 ? { requestId: request.requestId } : {};
  const call: RangeCall | undefined =
    c.case === 'command'
      ? { kind: 'command', argv: c.value.argv, ...id }
      : c.case === 'batch'
        ? {
            kind: 'batch',
            ...id,
            writes: c.value.writes.map((w) => w.argv),
            watches: c.value.watches.map((w) => ({ key: w.key, version: w.version })),
          }
        : c.case === 'watch'
          ? { kind: 'watch', keys: c.value.keys }
          : undefined;
  return call ? { rangeId: request.rangeId, caller, call } : undefined;
}

/** A `ForwardCall` over Connect that stamps the node's HLC on each request. */
export function connectForwardCall(
  forwarder: KvForwarder,
  clock: ClockSync,
  selfAddress: () => string,
): ForwardCall {
  return async (address, rangeId, caller, call): Promise<Result<KvReply, MindlogError>> => {
    const reply = await forwarder.execute(
      address,
      toRequest(rangeId, caller, call, clock.stamp(), selfAddress()),
    );
    return reply;
  };
}
