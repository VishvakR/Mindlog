import type { Hlc, MindlogError, Result } from '@mindlog/core';
import { err, hlcPhysical, mindlogError, ok } from '@mindlog/core';
import type { KvCommandRegistry } from '@mindlog/kv';
import { KvReadExecutor, headerKey } from '@mindlog/kv';
import type { RangeDescriptor, TxnOutcome } from '@mindlog/proto';
import { SpanReader, inSpan } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { readLock } from './lock-store.js';
import { TxnStatus, outcome } from './outcome.js';

export interface SnapshotReadDeps {
  readonly registry: KvCommandRegistry;
  /** The node's whole state store (locks are range-local keys, which a span reader hides). */
  readonly state: KvReader;
  /** The range being read, as this node knows it; the caller has waited for a read barrier. */
  readonly descriptor: RangeDescriptor;
  readonly tenant: string;
}

/**
 * Runs a read command as of `ts` (ADR-0030). A key locked by a transaction that
 * began at or before `ts` may yet commit at or before `ts`, so the answer is
 * the lock, for the caller to resolve; otherwise it is the snapshot's value.
 */
export async function snapshotRead(
  d: SnapshotReadDeps,
  argv: readonly Uint8Array[],
  ts: bigint,
): Promise<Result<TxnOutcome, MindlogError>> {
  // The range may have split since the caller chose it: a span reader would answer "no such key".
  for (const key of d.registry.keysOf(argv))
    if (!inSpan(d.descriptor, headerKey(d.tenant, key)))
      return err(mindlogError('RANGE_MOVED', `key is not in range ${d.descriptor.rangeId}`));
  for (const key of d.registry.keysOf(argv)) {
    const lock = await readLock(d.state, d.descriptor.rangeId, d.tenant, key);
    if (lock && lock.startTs <= ts)
      return ok(
        outcome({
          status: TxnStatus.LOCKED,
          lockedKey: key,
          lockedPrimary: lock.primary,
          lockedStartTs: lock.startTs,
        }),
      );
  }
  const reply = await new KvReadExecutor(d.registry, new SpanReader(d.state, d.descriptor)).execute(
    d.tenant,
    argv,
    hlcPhysical(ts as Hlc),
    ts,
  );
  return ok(outcome({ status: TxnStatus.OK, replies: [reply] }));
}
