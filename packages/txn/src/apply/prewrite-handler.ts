import type { KvCommandRegistry } from '@mindlog/kv';
import { headerKey, outsideRange } from '@mindlog/kv';
import type { ApplyHandler } from '@mindlog/statemachine';
import { errorResult } from '@mindlog/statemachine';
import {
  commitRecordKey,
  encodeLock,
  lockKey,
  readLock,
  rollbackRecordKey,
} from '../lock-store.js';
import { TxnStatus, txnResult } from '../outcome.js';

/**
 * Applies `TxnPrewrite` (ADR-0030): locks every key the writes touch, or none.
 * The staged argv sits in the lock of its first key and runs only at commit.
 */
export function txnPrewriteHandler(registry: KvCommandRegistry): ApplyHandler {
  return {
    body: 'txnPrewrite',
    async apply(context) {
      const { command, txn, raw, descriptor, nowMs } = context;
      if (command.body.case !== 'txnPrewrite')
        return errorResult('INTERNAL', 'expected a txnPrewrite body');
      const { startTs, primary, ttlMs, writes } = command.body.value;
      const staged = writes.map((w) => ({ argv: w.argv, keys: registry.keysOf(w.argv) }));
      const keys = staged.flatMap((w) => w.keys);
      const moved = outsideRange(context, keys);
      if (moved) return moved;
      const rangeId = descriptor.rangeId;
      for (const key of keys) {
        // A retry of a prewrite that went on to commit has nothing left to do.
        if (await raw.reader.get(commitRecordKey(rangeId, command.tenant, key, startTs)))
          return txnResult({ status: TxnStatus.OK });
        const lock = await readLock(raw.reader, rangeId, command.tenant, key);
        // The same transaction prewriting again (a retry) is fine.
        if (lock && lock.startTs !== startTs)
          return txnResult({
            status: TxnStatus.LOCKED,
            lockedKey: key,
            lockedPrimary: lock.primary,
            lockedStartTs: lock.startTs,
          });
        if (await raw.reader.get(rollbackRecordKey(rangeId, command.tenant, key, startTs)))
          return txnResult({ status: TxnStatus.CONFLICT });
        if ((await txn.latestIndex(headerKey(command.tenant, key))) > startTs)
          return txnResult({ status: TxnStatus.CONFLICT });
      }
      for (const w of staged)
        for (const [i, key] of w.keys.entries())
          raw.batch.put(
            lockKey(rangeId, command.tenant, key),
            encodeLock({
              startTs,
              primary,
              ttlMs,
              lockedAtMs: nowMs,
              argv: i === 0 ? w.argv : [],
            }),
          );
      return txnResult({ status: TxnStatus.OK });
    },
  };
}
