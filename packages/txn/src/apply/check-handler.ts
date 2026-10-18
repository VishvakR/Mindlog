import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { commitRecordKey, lockKey, readLock, readU64, rollbackRecordKey } from '../lock-store.js';
import { TxnStatus, txnResult } from '../outcome.js';

/**
 * Applies `TxnCheck` (ADR-0030): what became of a transaction, asked of its
 * primary's range. A lock past its TTL, or no trace of the transaction, rolls
 * it back here, which also stops a late prewrite or commit of it.
 */
export const txnCheckHandler: ApplyHandler = {
  body: 'txnCheck',
  async apply(context) {
    const { command, raw, descriptor, nowMs } = context;
    if (command.body.case !== 'txnCheck')
      return errorResult('INTERNAL', 'expected a txnCheck body');
    const { startTs, primary } = command.body.value;
    const rangeId = descriptor.rangeId;
    const tenant = command.tenant;
    const committed = await raw.reader.get(commitRecordKey(rangeId, tenant, primary, startTs));
    if (committed) return txnResult({ status: TxnStatus.COMMITTED, commitTs: readU64(committed) });
    const lock = await readLock(raw.reader, rangeId, tenant, primary);
    if (lock?.startTs === startTs) {
      // The time of the prewrite and of this check both come from commands, so every replica agrees.
      if (lock.lockedAtMs + lock.ttlMs > nowMs)
        return txnResult({
          status: TxnStatus.LOCKED,
          lockedKey: primary,
          lockedPrimary: primary,
          lockedStartTs: startTs,
        });
      raw.batch.del(lockKey(rangeId, tenant, primary));
    }
    raw.batch.put(rollbackRecordKey(rangeId, tenant, primary, startTs), new Uint8Array());
    return txnResult({ status: TxnStatus.ROLLED_BACK });
  },
};
