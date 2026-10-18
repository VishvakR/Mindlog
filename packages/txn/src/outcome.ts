import { create } from '@bufbuild/protobuf';
import type { CommandResult, KvReply } from '@mindlog/proto';
import { CommandResultSchema, TxnOutcomeSchema, TxnStatus } from '@mindlog/proto';

export interface OutcomeInit {
  status: TxnStatus;
  commitTs?: bigint;
  lockedKey?: Uint8Array;
  lockedPrimary?: Uint8Array;
  lockedStartTs?: bigint;
  replies?: KvReply[];
}

export const outcome = (init: OutcomeInit) => create(TxnOutcomeSchema, { replies: [], ...init });

export const txnResult = (init: OutcomeInit): CommandResult =>
  create(CommandResultSchema, { outcome: { case: 'txn', value: outcome(init) } });

export { TxnStatus };
