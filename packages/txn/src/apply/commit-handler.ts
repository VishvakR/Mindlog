import type { Hlc } from '@mindlog/core';
import { hlcPhysical } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import { Keyspace, outsideRange } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import { SpanReader, errorResult } from '@mindlog/statemachine';
import { MvccTxn } from '@mindlog/storage';
import { commitRecordKey, lockKey, readLock, rollbackRecordKey, u64 } from '../lock-store.js';
import { TxnStatus, txnResult } from '../outcome.js';

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Applies `TxnCommit` (ADR-0030): for each key whose lock belongs to the
 * transaction, runs the staged write at the commit timestamp and releases the
 * lock. Committing the primary is the commit point of the whole transaction.
 */
export function txnCommitHandler(registry: KvCommandRegistry): ApplyHandler {
  return {
    body: 'txnCommit',
    async apply(context) {
      const { command, raw, descriptor, random } = context;
      if (command.body.case !== 'txnCommit')
        return errorResult('INTERNAL', 'expected a txnCommit body');
      const { startTs, commitTs, keys, primary } = command.body.value;
      const moved = outsideRange(context, keys);
      if (moved) return moved;
      const rangeId = descriptor.rangeId;
      const tenant = command.tenant;
      // Written at the commit timestamp, not this apply's version: a reader at or after it must see the write.
      const txn = new MvccTxn(new SpanReader(raw.reader, descriptor), commitTs);
      const keyspace = new Keyspace({
        tenant,
        nowMs: hlcPhysical(commitTs as Hlc),
        view: txn,
        writer: txn,
        version: commitTs,
        random,
        local: { rangeId, batch: raw.batch },
      });
      // Decide for every key before changing anything, so an abort leaves no partial commit.
      const locks = new Map<Uint8Array, Uint8Array[]>();
      for (const key of keys) {
        const lock = await readLock(raw.reader, rangeId, tenant, key);
        if (lock?.startTs === startTs) {
          locks.set(key, [...lock.argv]);
          continue;
        }
        if (await raw.reader.get(commitRecordKey(rangeId, tenant, key, startTs))) continue;
        // No lock and no record: the primary was rolled back or never locked; a secondary was committed already.
        if (
          same(key, primary) ||
          (await raw.reader.get(rollbackRecordKey(rangeId, tenant, key, startTs)))
        )
          return txnResult({ status: TxnStatus.ABORTED });
      }
      const replies: KvReply[] = [];
      for (const [key, argv] of locks) {
        if (argv.length > 0) replies.push(await registry.dispatch(keyspace, argv));
        raw.batch.del(lockKey(rangeId, tenant, key));
        raw.batch.put(commitRecordKey(rangeId, tenant, key, startTs), u64(commitTs));
      }
      txn.writeTo(raw.batch);
      return txnResult({ status: TxnStatus.OK, commitTs, replies });
    },
  };
}
