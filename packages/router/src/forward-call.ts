import type { MindlogError, Result } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
import type { Caller, RangeCall } from '@mindlog/services';

/** Sends a call to the node at an internal address; the server wires the Connect client in. */
export type ForwardCall = (
  address: string,
  rangeId: bigint,
  caller: Caller,
  call: RangeCall,
) => Promise<Result<KvReply, MindlogError>>;
