import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { prefixRange } from '@mindlog/core';
import type {
  CommandResult,
  ConfState,
  Freeze,
  Merge,
  RangeDescriptor,
  Split,
} from '@mindlog/proto';
import {
  CommandResultSchema,
  ConfStateSchema,
  RangeDescriptorSchema,
  RangeEpochSchema,
} from '@mindlog/proto';
import type { KvReader, WriteBatch } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import { errorResult } from '../apply/command-results.js';
import {
  appliedIndexKey,
  confStateKey,
  lastVersionKey,
  rangeDescriptorKey,
  rangeLocalKey,
  rangeLocalPrefix,
} from '../system/system-keys.js';
import { RANGE_INIT_INDEX, inSpan } from './span.js';

/** Raw access to the node's state store inside one apply batch. */
export interface RawState {
  readonly reader: KvReader;
  readonly batch: WriteBatch;
}

/**
 * Range-local state that a package other than the state machine keeps (for
 * example the KV expiry index), moved along when ranges split or merge.
 */
export interface RangeHooks {
  /** Moves `left`'s entries for keys at or after `splitKey` to `right`. */
  split(raw: RawState, left: bigint, right: bigint, splitKey: Uint8Array): Promise<void>;
  /** Moves all of `right`'s entries to `left`. */
  merge(raw: RawState, left: bigint, right: bigint): Promise<void>;
}

/** The applying range as a range command sees it. */
export interface RangeContext extends RawState {
  readonly descriptor: RangeDescriptor;
  readonly confState: ConfState;
  /** Version of this apply (ADR-0027). */
  readonly version: bigint;
  /** The range's approximate size before this command. */
  readonly bytes: bigint;
  readonly hooks: readonly RangeHooks[];
}

/** What a range command changed, for the state machine to adopt. */
export interface RangeChange {
  readonly result: CommandResult;
  readonly descriptor?: RangeDescriptor;
  readonly bytes?: bigint;
  readonly frozenFor?: bigint;
  readonly lastVersion?: bigint;
}

export const OK_RESULT = create(CommandResultSchema, {
  outcome: { case: 'kv', value: { kind: { case: 'simple', value: 'OK' } } },
});

export const encodeU64 = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n);
  return out;
};

export const decodeU64 = (bytes: Uint8Array): bigint =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0);

export const statsKey = (rangeId: bigint): Uint8Array => rangeLocalKey(rangeId, 'range-stats');
export const frozenKey = (rangeId: bigint): Uint8Array => rangeLocalKey(rangeId, 'frozen');

const initApplied = (): Uint8Array => {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, RANGE_INIT_INDEX);
  view.setBigUint64(8, RANGE_INIT_INDEX);
  return out;
};

const bumpVersion = (d: RangeDescriptor, version: bigint) =>
  create(RangeEpochSchema, { confVersion: d.epoch?.confVersion ?? 0n, version });

/** Copies `from`'s idempotency records to `to`, so retries keep their results across a split or merge. */
async function copyIdempotency(raw: RawState, from: bigint, to: bigint): Promise<void> {
  for (const tag of ['idem', 'idem-at']) {
    const source = rangeLocalPrefix(from, tag);
    const target = rangeLocalPrefix(to, tag);
    for await (const [key, value] of raw.reader.iterate(prefixRange(source))) {
      const moved = new Uint8Array(target.length + key.length - source.length);
      moved.set(target);
      moved.set(key.subarray(source.length), target.length);
      raw.batch.put(moved, value);
    }
  }
}

/**
 * Applies `Split` (ADR-0009): the left side ends at the split key, the right
 * side starts there as a new range at the init index with the same members.
 * If this node already holds an initialised right replica (it got a snapshot
 * first), its state is left alone.
 */
export async function applySplit(ctx: RangeContext, split: Split): Promise<RangeChange> {
  const d = ctx.descriptor;
  const key = split.splitKey;
  if (compareBytes(key, d.startKey) <= 0 || !inSpan(d, key) || split.newRangeId === d.rangeId)
    return { result: errorResult('INVALID_ARGUMENT', 'the split key is not inside the range') };
  const epoch = bumpVersion(d, (d.epoch?.version ?? 0n) + 1n);
  const left = create(RangeDescriptorSchema, { ...d, endKey: key, epoch });
  const right = create(RangeDescriptorSchema, {
    ...d,
    rangeId: split.newRangeId,
    startKey: key,
    epoch,
  });
  const id = right.rangeId;
  if (!(await ctx.reader.get(appliedIndexKey(id)))) {
    ctx.batch.put(appliedIndexKey(id), initApplied());
    ctx.batch.put(confStateKey(id), toBinary(ConfStateSchema, ctx.confState));
    ctx.batch.put(rangeDescriptorKey(id), toBinary(RangeDescriptorSchema, right));
    ctx.batch.put(lastVersionKey(id), encodeU64(ctx.version));
    ctx.batch.put(statsKey(id), encodeU64(split.rightBytes));
    await copyIdempotency(ctx, d.rangeId, id);
  }
  for (const hook of ctx.hooks) await hook.split(ctx, d.rangeId, id, key);
  ctx.batch.put(rangeDescriptorKey(d.rangeId), toBinary(RangeDescriptorSchema, left));
  return { result: OK_RESULT, descriptor: left, bytes: split.leftBytes };
}

/** Applies `Freeze`: `mergeInto` > 0 freezes the range for that merge, 0 unfreezes it. */
export function applyFreeze(ctx: RangeContext, freeze: Freeze): RangeChange {
  if (freeze.mergeInto === 0n) ctx.batch.del(frozenKey(ctx.descriptor.rangeId));
  else ctx.batch.put(frozenKey(ctx.descriptor.rangeId), encodeU64(freeze.mergeInto));
  return { result: OK_RESULT, frozenFor: freeze.mergeInto };
}

const sameMembers = (a: ConfState, b: ConfState): boolean =>
  [...a.voters].sort().join() === [...b.voters].sort().join() &&
  [...a.learners].sort().join() === [...b.learners].sort().join();

/**
 * Whether a merge command's right-hand members are the applying range's. A replica
 * checks this before waiting for its right replica: when it fails, apply refuses the
 * merge everywhere, and a removed member could never catch up to the freeze.
 */
export const mergeMembersMatch = (merge: Merge, confState: ConfState): boolean =>
  sameMembers(
    create(ConfStateSchema, { voters: merge.rightVoters, learners: merge.rightLearners }),
    confState,
  );

/**
 * Applies `Merge` (ADR-0009): the frozen right-hand neighbour's span, state
 * and idempotency records join this range; its own range-local state is
 * deleted. The caller makes sure the local right replica has applied the
 * freeze and is stopped before this runs.
 */
export async function applyMerge(ctx: RangeContext, merge: Merge): Promise<RangeChange> {
  const d = ctx.descriptor;
  const right = merge.right;
  const id = right?.rangeId ?? 0n;
  const [stored, frozen, version, stats] = await Promise.all([
    ctx.reader.get(rangeDescriptorKey(id)),
    ctx.reader.get(frozenKey(id)),
    ctx.reader.get(lastVersionKey(id)),
    ctx.reader.get(statsKey(id)),
  ]);
  const refuse = (why: string): RangeChange => ({ result: errorResult('CONFLICT', why) });
  // Only the span is compared: it is fixed once the range is frozen, while the local
  // epoch's conf version and membership may lag on a replica that is behind.
  const local = stored ? fromBinary(RangeDescriptorSchema, stored) : undefined;
  if (
    !right ||
    !local ||
    compareBytes(local.startKey, right.startKey) !== 0 ||
    compareBytes(local.endKey, right.endKey) !== 0
  )
    return refuse('the right range is not the one this node holds');
  if (compareBytes(right.startKey, d.endKey) !== 0 || d.endKey.length === 0)
    return refuse('the ranges are not neighbours');
  if (!frozen || decodeU64(frozen) !== d.rangeId)
    return refuse('the right range is not frozen for this merge');
  if (!mergeMembersMatch(merge, ctx.confState)) return refuse('the ranges have different members');

  const top = (d.epoch?.version ?? 0n) > (right.epoch?.version ?? 0n) ? d.epoch : right.epoch;
  const merged = create(RangeDescriptorSchema, {
    ...d,
    endKey: right.endKey,
    epoch: bumpVersion(d, (top?.version ?? 0n) + 1n),
  });
  await copyIdempotency(ctx, id, d.rangeId);
  for (const hook of ctx.hooks) await hook.merge(ctx, d.rangeId, id);
  for await (const [key] of ctx.reader.iterate(prefixRange(rangeLocalPrefix(id))))
    ctx.batch.del(key);
  ctx.batch.put(rangeDescriptorKey(d.rangeId), toBinary(RangeDescriptorSchema, merged));
  const rightVersion = version ? decodeU64(version) : 0n;
  return {
    result: OK_RESULT,
    descriptor: merged,
    lastVersion: rightVersion > ctx.version ? rightVersion : ctx.version,
    bytes: ctx.bytes + (stats ? decodeU64(stats) : 0n),
  };
}
