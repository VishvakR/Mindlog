import { fromBinary, toBinary, create } from '@bufbuild/protobuf';
import type { TxnLock } from '@mindlog/proto';
import { TxnLockSchema } from '@mindlog/proto';
import { rangeLocalKey } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';

/** Range-local keys of the transaction state (ADR-0030); they follow their keys on split and merge. */
export const LOCK = 'txn-lock';
export const COMMIT = 'txn-commit';
export const ROLLBACK = 'txn-rb';

export const lockKey = (rangeId: bigint, tenant: string, key: Uint8Array): Uint8Array =>
  rangeLocalKey(rangeId, LOCK, tenant, key);

export const commitRecordKey = (
  rangeId: bigint,
  tenant: string,
  key: Uint8Array,
  startTs: bigint,
): Uint8Array => rangeLocalKey(rangeId, COMMIT, tenant, key, startTs);

export const rollbackRecordKey = (
  rangeId: bigint,
  tenant: string,
  key: Uint8Array,
  startTs: bigint,
): Uint8Array => rangeLocalKey(rangeId, ROLLBACK, tenant, key, startTs);

export const encodeLock = (lock: {
  startTs: bigint;
  primary: Uint8Array;
  ttlMs: bigint;
  lockedAtMs: bigint;
  argv: readonly Uint8Array[];
}): Uint8Array => toBinary(TxnLockSchema, create(TxnLockSchema, { ...lock, argv: [...lock.argv] }));

export async function readLock(
  reader: KvReader,
  rangeId: bigint,
  tenant: string,
  key: Uint8Array,
): Promise<TxnLock | undefined> {
  const raw = await reader.get(lockKey(rangeId, tenant, key));
  return raw ? fromBinary(TxnLockSchema, raw) : undefined;
}

export const u64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

export const readU64 = (raw: Uint8Array): bigint =>
  new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getBigUint64(0);
