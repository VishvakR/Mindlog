import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { ManualClock, MemoryLogger, MemoryMetrics, packHlc, prefixRange } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { Command, CommandResult, RangeDescriptor } from '@mindlog/proto';
import { CommandSchema, ConfStateSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import type { RangeHooks } from '@mindlog/statemachine';
import {
  ApplyHandlerRegistry,
  RANGE_INIT_INDEX,
  StateMachine,
  localRanges,
  rangeLocalKey,
  rangeLocalPrefix,
} from '@mindlog/statemachine';
import { counterHandler, counterKey, writeCommand } from './support/counter-handler.js';

const utf8 = new TextEncoder();
let seq = 0;

function body(value: NonNullable<MessageInitShape<typeof CommandSchema>['body']>): Command {
  return create(CommandSchema, { requestId: utf8.encode(`range-${seq++}`), body: value });
}

const split = (key: Uint8Array, newRangeId: bigint, leftBytes = 10n, rightBytes = 20n) =>
  body({ case: 'split', value: { splitKey: key, newRangeId, leftBytes, rightBytes } });
const freeze = (mergeInto: bigint) => body({ case: 'freeze', value: { mergeInto } });
const merge = (right: RangeDescriptor, freezeIndex: number | bigint, voters = [1n, 2n]) =>
  body({
    case: 'merge',
    value: { right, freezeIndex: BigInt(freezeIndex), rightVoters: voters },
  });

/** Records hook calls and moves one marker key per range. */
function markerHooks(calls: string[]): RangeHooks {
  return {
    async split(raw, left, right, splitKey) {
      calls.push(`split ${left}->${right} at ${splitKey.length}`);
      if (await raw.reader.get(rangeLocalKey(left, 'marker'))) {
        raw.batch.del(rangeLocalKey(left, 'marker'));
        raw.batch.put(rangeLocalKey(right, 'marker'), Uint8Array.of(1));
      }
    },
    async merge(raw, left, right) {
      calls.push(`merge ${right}->${left}`);
      if (await raw.reader.get(rangeLocalKey(right, 'marker'))) {
        raw.batch.del(rangeLocalKey(right, 'marker'));
        raw.batch.put(rangeLocalKey(left, 'marker'), Uint8Array.of(1));
      }
    },
  };
}

async function open(store: KvStore, rangeId: bigint, hooks: RangeHooks[] = []) {
  const handlers = new ApplyHandlerRegistry();
  handlers.register(counterHandler);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  return StateMachine.open({
    store,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock: new ManualClock(),
    logger,
    metrics,
    rangeId,
    rangeHooks: hooks,
  });
}

const errorCode = (r: CommandResult) => (r.outcome.case === 'error' ? r.outcome.value.code : 'ok');
const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);

async function bootstrapped(store: KvStore, hooks: RangeHooks[] = []) {
  const left = await open(store, 1n, hooks);
  await left.bootstrap(create(ConfStateSchema, { voters: [1n, 2n] }));
  return left;
}

describe('range commands (ADR-0009)', () => {
  test('a split shrinks the left range and creates the right one at the init index', async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const left = await bootstrapped(store, [markerHooks(calls)]);
    await left.apply(6n, 5n, writeCommand(['INCR', 'a'], 'a1', packHlc(1_000n, 0n)));
    const once = await left.apply(7n, 5n, writeCommand(['INCR', 'x'], 'x1', packHlc(1_000n, 0n)));
    const marker = store.batch();
    marker.put(rangeLocalKey(1n, 'marker'), Uint8Array.of(1));
    await marker.write();

    expect(errorCode(await left.apply(8n, 5n, split(counterKey('m'), 2n)))).toBe('ok');
    expect(left.descriptor.endKey).toEqual(counterKey('m'));
    expect(left.descriptor.epoch?.version).toBe(1n);
    expect(left.approximateBytes).toBe(10n);
    expect(calls).toEqual([`split 1->2 at ${counterKey('m').length}`]);

    const right = await open(store, 2n);
    expect(right.applied).toEqual({ index: RANGE_INIT_INDEX, term: RANGE_INIT_INDEX });
    expect(right.descriptor).toMatchObject({ rangeId: 2n, startKey: counterKey('m') });
    expect(right.descriptor.epoch?.version).toBe(1n);
    expect(right.confState.voters).toEqual([1n, 2n]);
    expect(right.lastVersion).toBe(left.lastVersion);
    expect(right.approximateBytes).toBe(20n);
    expect(await store.get(rangeLocalKey(2n, 'marker'))).toBeDefined();
    // The right range keeps the left's idempotency records and sees its data.
    expect(await right.apply(6n, 5n, writeCommand(['INCR', 'x'], 'x1'))).toEqual(once);
    await right.apply(7n, 5n, writeCommand(['INCR', 'x'], 'x2'));
    expect(text(await new MvccReader(store).get(counterKey('x')))).toBe('2');
  });

  test('a split key outside the range, or at its start, is a recorded error', async () => {
    const store = new MemoryStore();
    const left = await bootstrapped(store);
    await left.apply(6n, 5n, split(counterKey('m'), 2n));
    expect(errorCode(await left.apply(7n, 5n, split(counterKey('q'), 3n)))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(errorCode(await left.apply(8n, 5n, split(new Uint8Array(), 3n)))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(left.descriptor.endKey).toEqual(counterKey('m'));
  });

  test('a frozen range refuses commands until it is unfrozen', async () => {
    const store = new MemoryStore();
    const machine = await bootstrapped(store);
    await machine.apply(6n, 5n, freeze(9n));
    expect(machine.frozenFor).toBe(9n);
    const version = machine.lastVersion;
    const refused = writeCommand(['INCR', 'a'], 'while-frozen');
    expect(errorCode(await machine.apply(7n, 5n, refused))).toBe('RANGE_MOVED');
    expect(errorCode(await machine.apply(8n, 5n, freeze(9n)))).toBe('ok');
    // Refused commands and repeated freezes take no version; the refusal is recorded, so a
    // re-proposed copy gets the same answer after the unfreeze.
    expect(machine.lastVersion).toBe(version);
    await machine.apply(9n, 5n, freeze(0n));
    expect(errorCode(await machine.apply(10n, 5n, refused))).toBe('RANGE_MOVED');
    expect(errorCode(await machine.apply(11n, 5n, writeCommand(['INCR', 'a'])))).toBe('ok');
    expect((await open(store, 1n)).frozenFor).toBe(0n);
  });

  test('a merge folds the frozen right range into the left one', async () => {
    const store = new MemoryStore();
    const calls: string[] = [];
    const left = await bootstrapped(store, [markerHooks(calls)]);
    await left.apply(6n, 5n, split(counterKey('m'), 2n));
    const right = await open(store, 2n);
    await right.apply(6n, 5n, writeCommand(['INCR', 'x'], 'x1', packHlc(9_000n, 0n)));
    const marker = store.batch();
    marker.put(rangeLocalKey(2n, 'marker'), Uint8Array.of(1));
    await marker.write();
    await right.apply(7n, 5n, freeze(1n));

    expect(errorCode(await left.apply(7n, 5n, merge(right.descriptor, 7n)))).toBe('ok');
    expect(left.descriptor).toMatchObject({ startKey: new Uint8Array(), endKey: new Uint8Array() });
    expect(left.descriptor.epoch?.version).toBe(2n);
    // A freeze takes no version, so the right range's last write is what is folded in.
    expect(left.lastVersion).toBe(packHlc(9_000n, 0n));
    expect(calls.at(-1)).toBe('merge 2->1');
    expect(await store.get(rangeLocalKey(1n, 'marker'))).toBeDefined();
    let leftover = 0;
    for await (const _ of store.iterate(prefixRange(rangeLocalPrefix(2n)))) leftover++;
    expect(leftover).toBe(0);
    expect(await left.apply(8n, 5n, writeCommand(['INCR', 'x'], 'x1'))).toMatchObject({
      outcome: { case: 'kv' },
    });
    await left.apply(9n, 5n, writeCommand(['INCR', 'x'], 'x2'));
    expect(text(await new MvccReader(store).get(counterKey('x')))).toBe('2');
  });

  test('a merge does not fold in what the frozen range refused, so replicas agree', async () => {
    // SIM_MEM seed 197: replicas that had and had not applied the refusals of a frozen range
    // merged different idempotency tables, and a retry applied on some replicas only.
    const store = new MemoryStore();
    const left = await bootstrapped(store);
    await left.apply(6n, 5n, split(counterKey('m'), 2n));
    const right = await open(store, 2n);
    await right.apply(6n, 5n, freeze(1n));
    const retried = writeCommand(['INCR', 'y'], 'refused-then-retried');
    expect(errorCode(await right.apply(7n, 5n, retried))).toBe('RANGE_MOVED');
    expect(errorCode(await left.apply(7n, 5n, merge(right.descriptor, 6n)))).toBe('ok');
    let leftover = 0;
    for await (const _ of store.iterate(prefixRange(rangeLocalPrefix(2n)))) leftover++;
    expect(leftover).toBe(0);
    // After the merge the retry is applied: no replica remembers the refusal.
    expect(errorCode(await left.apply(8n, 5n, retried))).toBe('ok');
    expect(text(await new MvccReader(store).get(counterKey('y')))).toBe('1');
  });

  test('a merge is refused unless the right range is frozen into this one with the same members', async () => {
    const store = new MemoryStore();
    const left = await bootstrapped(store);
    await left.apply(6n, 5n, split(counterKey('m'), 2n));
    const right = await open(store, 2n);
    expect(errorCode(await left.apply(7n, 5n, merge(right.descriptor, 5n)))).toBe('CONFLICT');
    await right.apply(6n, 5n, freeze(1n));
    expect(errorCode(await left.apply(8n, 5n, merge(right.descriptor, 6n, [1n, 9n])))).toBe(
      'CONFLICT',
    );
    expect(left.descriptor.endKey).toEqual(counterKey('m'));
  });

  test('applied writes grow the approximate size', async () => {
    const machine = await bootstrapped(new MemoryStore());
    await machine.apply(6n, 5n, writeCommand(['INCR', 'a']));
    expect(machine.approximateBytes).toBeGreaterThan(0n);
  });
});

describe('findSplitKey (ADR-0009)', () => {
  test('picks the first key boundary at or after the byte median, with both sizes', async () => {
    const machine = await bootstrapped(new MemoryStore());
    let index = 6n;
    for (const name of ['a', 'b', 'c', 'd', 'e', 'f'])
      await machine.apply(index++, 5n, writeCommand(['INCR', name]));
    const found = await machine.findSplitKey();
    expect(found?.splitKey).toEqual(counterKey('d'));
    expect(found && found.leftBytes > 0n && found.rightBytes > 0n).toBe(true);
  });

  test('never splits inside one key: all versions of a key stay together', async () => {
    const machine = await bootstrapped(new MemoryStore());
    for (let i = 0; i < 5; i++)
      await machine.apply(BigInt(6 + i), 5n, writeCommand(['INCR', 'big']));
    expect(await machine.findSplitKey()).toBeUndefined();
  });
});

describe('localRanges', () => {
  test('lists the ranges whose state is in the store, split-created ones included', async () => {
    const store = new MemoryStore();
    expect(await localRanges(store)).toEqual([]);
    const left = await bootstrapped(store);
    await left.apply(6n, 5n, writeCommand(['INCR', 'a']));
    await left.apply(7n, 5n, writeCommand(['INCR', 'x']));
    await left.apply(8n, 5n, split(counterKey('m'), 7n));
    expect(await localRanges(store)).toEqual([1n, 7n]);
  });
});

describe('snapshots of range state', () => {
  test('a replica installing a snapshot of a frozen range is frozen too', async () => {
    const source = await bootstrapped(new MemoryStore());
    await source.apply(6n, 5n, writeCommand(['INCR', 'a']));
    await source.apply(7n, 5n, freeze(4n));
    const snapshot = await source.snapshot();
    const pairs = [];
    for await (const chunk of snapshot.chunks(1 << 20)) pairs.push(...chunk);
    await snapshot.release();

    const target = await open(new MemoryStore(), 1n);
    await target.installSnapshot(snapshot.meta, pairs);
    expect(target.frozenFor).toBe(4n);
    expect(target.approximateBytes).toBe(source.approximateBytes);
    expect(errorCode(await target.apply(8n, 5n, writeCommand(['INCR', 'a'])))).toBe('RANGE_MOVED');
  });
});

describe('replica id', () => {
  test('is remembered once, survives a restart, and is not replaced by a snapshot of another replica', async () => {
    const store = new MemoryStore();
    const mine = await bootstrapped(store);
    await mine.rememberReplicaId(1001n);
    await mine.rememberReplicaId(9n);
    expect(mine.replicaId).toBe(1001n);
    expect((await open(store, 1n)).replicaId).toBe(1001n);

    const leaderStore = new MemoryStore();
    const leader = await bootstrapped(leaderStore);
    await leader.rememberReplicaId(7n);
    await leader.apply(6n, 5n, writeCommand(['INCR', 'a']));
    const snapshot = await leader.snapshot();
    const pairs = [];
    for await (const chunk of snapshot.chunks(1 << 20)) pairs.push(...chunk);
    await snapshot.release();
    await mine.installSnapshot(snapshot.meta, pairs);
    expect(mine.applied.index).toBe(6n);
    expect((await open(store, 1n)).replicaId).toBe(1001n);
  });
});
