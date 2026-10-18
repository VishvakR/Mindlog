import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import { commitRecordKey, lockKey, readLock, rollbackRecordKey } from '../lock-store.js';
import { TxnStatus, txnResult } from '../outcome.js';

/**
 * Applies `TxnRollback` (ADR-0030): releases the transaction's locks and leaves
 * a rollback record, so a prewrite or commit of it that arrives late fails.
 */
export const txnRollbackHandler: ApplyHandler = {
  body: 'txnRollback',
  async apply(context) {
    const { command, raw, descriptor } = context;
    if (command.body.case !== 'txnRollback')
      return errorResult('INTERNAL', 'expected a txnRollback body');
    const { startTs, keys } = command.body.value;
    const rangeId = descriptor.rangeId;
    for (const key of keys) {
      // A key that committed stays committed.
      if (await raw.reader.get(commitRecordKey(rangeId, command.tenant, key, startTs))) continue;
      const lock = await readLock(raw.reader, rangeId, command.tenant, key);
      if (lock?.startTs === startTs) raw.batch.del(lockKey(rangeId, command.tenant, key));
      raw.batch.put(rollbackRecordKey(rangeId, command.tenant, key, startTs), new Uint8Array());
    }
    return txnResult({ status: TxnStatus.ROLLED_BACK });
  },
};
