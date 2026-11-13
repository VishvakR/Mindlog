import { fromBinary } from '@bufbuild/protobuf';
import type { Clock, Logger, Metrics, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { PD_DESCRIPTOR, PD_RANGE_ID, clearPlacement } from '@mindlog/pd';
import type { RangeDescriptor } from '@mindlog/proto';
import { RangeDescriptorSchema } from '@mindlog/proto';
import {
  ApplyHandlerRegistry,
  StateMachine,
  rangeDescriptorKey,
  soleVoter,
} from '@mindlog/statemachine';
import type { KvStore } from '@mindlog/storage';
import type { RangeBackup } from './backup-format.js';

export interface RestoreTargets {
  /** The node's state store. */
  readonly state: KvStore;
  /** Its placement driver's state store. */
  readonly pd: KvStore;
}

export interface RestoreDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
}

const descriptorOf = (rangeId: bigint, b: RangeBackup): RangeDescriptor | undefined => {
  const key = rangeDescriptorKey(rangeId);
  const pair = b.pairs.find((p) => Buffer.compare(p.key, key) === 0);
  return pair ? fromBinary(RangeDescriptorSchema, pair.value) : undefined;
};

/**
 * The data ranges of a backup sorted by start key, if they tile the keyspace
 * exactly (ADR-0041): a split or merge while the backup ran leaves a gap or an
 * overlap, and such a backup is refused rather than restored partly.
 */
export function checkCoverage(
  ranges: ReadonlyMap<bigint, RangeBackup>,
): Result<RangeDescriptor[], MindlogError> {
  const bad = (why: string) => err(mindlogError('INVALID_ARGUMENT', `incomplete backup: ${why}`));
  if (!ranges.has(PD_RANGE_ID)) return bad('the placement driver (range 0) is missing');
  const data: RangeDescriptor[] = [];
  for (const [rangeId, b] of ranges) {
    if (rangeId === PD_RANGE_ID) continue;
    const d = descriptorOf(rangeId, b);
    if (!d) return bad(`range ${rangeId.toString()} has no descriptor`);
    data.push(d);
  }
  data.sort((a, b) => Buffer.compare(a.startKey, b.startKey));
  let expected: Uint8Array = new Uint8Array();
  for (const d of data) {
    if (Buffer.compare(d.startKey, expected) !== 0)
      return bad(`range ${d.rangeId.toString()} does not start where the previous range ends`);
    if (d.endKey.length === 0 && d !== data[data.length - 1])
      return bad(`range ${d.rangeId.toString()} ends at infinity but is not the last`);
    expected = d.endKey;
  }
  if (data.length === 0 || expected.length !== 0)
    return bad('the last range does not reach the end');
  return ok(data);
}

/**
 * Writes a backup into empty stores as a one-node cluster whose replicas all
 * have id `nodeId` (ADR-0041). On boot each range sees state ahead of an
 * empty log and resets the log to it (ADR-0026).
 */
export async function restoreInto(
  ranges: ReadonlyMap<bigint, RangeBackup>,
  targets: RestoreTargets,
  nodeId: bigint,
  deps: RestoreDeps,
): Promise<Result<RangeDescriptor[], MindlogError>> {
  const covered = checkCoverage(ranges);
  if (!covered.ok) return covered;
  const events = new InMemoryEventBus({ logger: deps.logger, metrics: deps.metrics });
  for (const [rangeId, b] of ranges) {
    const pd = rangeId === PD_RANGE_ID;
    const machine = await StateMachine.open({
      store: pd ? targets.pd : targets.state,
      handlers: new ApplyHandlerRegistry(),
      events,
      ...deps,
      rangeId,
      ...(pd ? { descriptor: PD_DESCRIPTOR } : {}),
    });
    await machine.installSnapshot(b.meta, soleVoter(rangeId, nodeId, b.pairs));
  }
  await clearPlacement(targets.pd);
  return covered;
}
