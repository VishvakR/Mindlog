import { create, toBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { ManualClock, MemoryLogger, MemoryMetrics, packHlc } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  CommandResultSchema,
  ConfStateSchema,
  KvBatchSchema,
  RangeDescriptorSchema,
} from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader, MvccWriter } from '@mindlog/storage';
import type { ApplyHandler } from '@mindlog/statemachine';
import { ApplyHandlerRegistry, StateMachine, rangeDescriptorKey } from '@mindlog/statemachine';
import { counterHandler, counterKey, writeCommand } from './support/counter-handler.js';

const utf8 = new TextEncoder();

/** Records each apply's version; `SCAN` replies with the keys an apply can see. */
function probe(versions: bigint[]): ApplyHandler {
  return {
    body: 'kvBatch',
    async apply({ txn, version }) {
      versions.push(version);
      const seen: Uint8Array[] = [];
      for await (const entry of txn.scan(new Uint8Array())) seen.push(entry.key);
      return create(CommandResultSchema, {
        outcome: { case: 'kv', value: { kind: { case: 'integer', value: BigInt(seen.length) } } },
      });
    },
  };
}

const batchCommand = (requestId: string, hlc = 0n) => ({
  ...writeCommand([], requestId, hlc),
  body: { case: 'kvBatch' as const, value: create(KvBatchSchema) },
});

async function open(store: KvStore, rangeId = 1n, versions: bigint[] = []) {
  const handlers = new ApplyHandlerRegistry();
  handlers.register(counterHandler);
  handlers.register(probe(versions));
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
  });
}

async function withSpan(store: KvStore, rangeId: bigint, start: Uint8Array, end: Uint8Array) {
  const batch = store.batch();
  batch.put(
    rangeDescriptorKey(rangeId),
    toBinary(
      RangeDescriptorSchema,
      create(RangeDescriptorSchema, { rangeId, startKey: start, endKey: end }),
    ),
  );
  await batch.write();
}

const integer = (r: Awaited<ReturnType<StateMachine['apply']>>) =>
  r.outcome.case === 'kv' && r.outcome.value.kind.case === 'integer'
    ? r.outcome.value.kind.value
    : undefined;

describe('range state (ADR-0027, ADR-0028)', () => {
  test('a new range covers the whole keyspace', async () => {
    const machine = await open(new MemoryStore(), 3n);
    expect(machine.descriptor).toMatchObject({
      rangeId: 3n,
      startKey: new Uint8Array(),
      endKey: new Uint8Array(),
    });
  });

  test('versions are max(hlc, last + 1) and survive a restart', async () => {
    const store = new MemoryStore();
    const versions: bigint[] = [];
    const machine = await open(store, 1n, versions);
    const t = packHlc(1_000n, 0n);
    await machine.apply(1n, 1n, batchCommand('a', t));
    await machine.apply(2n, 1n, batchCommand('b', t));
    await machine.apply(3n, 1n, batchCommand('c', packHlc(900n, 0n)));
    await machine.applyEmpty(4n, 1n);
    await machine.apply(5n, 1n, batchCommand('d', packHlc(2_000n, 0n)));
    expect(versions).toEqual([t, t + 1n, t + 2n, packHlc(2_000n, 0n)]);
    const reopened = await open(store, 1n, versions);
    expect(reopened.lastVersion).toBe(packHlc(2_000n, 0n));
    await reopened.apply(6n, 1n, batchCommand('e', 0n));
    expect(versions.at(-1)).toBe(packHlc(2_000n, 0n) + 1n);
  });

  test('writes are stored at the apply version', async () => {
    const store = new MemoryStore();
    const machine = await open(store);
    await machine.apply(1n, 1n, writeCommand(['INCR', 'n'], 'r1', packHlc(5_000n, 7n)));
    const reader = new MvccReader(store);
    expect(await reader.latestIndex(counterKey('n'))).toBe(packHlc(5_000n, 7n));
  });

  test('apply sees only keys inside the range span', async () => {
    const store = new MemoryStore();
    const batch = store.batch();
    new MvccWriter(batch, 1n).put(counterKey('z'), utf8.encode('x'));
    new MvccWriter(batch, 1n).put(counterKey('b'), utf8.encode('x'));
    await batch.write();
    await withSpan(store, 1n, new Uint8Array(), counterKey('m'));
    const machine = await open(store);
    expect(integer(await machine.apply(1n, 1n, batchCommand('scan')))).toBe(1n);
  });

  test('a snapshot carries only its span and its own range-local keys', async () => {
    const store = new MemoryStore();
    await withSpan(store, 1n, new Uint8Array(), counterKey('m'));
    await withSpan(store, 2n, counterKey('m'), new Uint8Array());
    const left = await open(store, 1n);
    const right = await open(store, 2n);
    await left.apply(1n, 1n, writeCommand(['INCR', 'a'], 'same'));
    await right.apply(1n, 1n, writeCommand(['INCR', 'x'], 'same'));
    expect(right.appliedIndex).toBe(1n);

    const snapshot = await right.snapshot();
    const pairs = [];
    for await (const chunk of snapshot.chunks(1 << 20)) pairs.push(...chunk);
    await snapshot.release();

    const target = new MemoryStore();
    await withSpan(target, 1n, new Uint8Array(), counterKey('m'));
    const keep = await open(target, 1n);
    await keep.apply(1n, 1n, writeCommand(['INCR', 'a']));
    const installed = await open(target, 2n);
    await installed.installSnapshot(snapshot.meta, pairs);

    const reader = new MvccReader(target);
    expect(await reader.get(counterKey('a'))).toEqual(utf8.encode('1'));
    expect(await reader.get(counterKey('x'))).toEqual(utf8.encode('1'));
    expect(installed.descriptor.startKey).toEqual(counterKey('m'));
    expect(keep.appliedIndex).toBe(1n);
    expect((await open(target, 1n)).appliedIndex).toBe(1n);
  });

  test('idempotency records are per range', async () => {
    const store = new MemoryStore();
    await withSpan(store, 1n, new Uint8Array(), counterKey('m'));
    await withSpan(store, 2n, counterKey('m'), new Uint8Array());
    const left = await open(store, 1n);
    const right = await open(store, 2n);
    await left.apply(1n, 1n, writeCommand(['INCR', 'a'], 'same'));
    await right.apply(1n, 1n, writeCommand(['INCR', 'x'], 'same'));
    expect(await new MvccReader(store).get(counterKey('x'))).toEqual(utf8.encode('1'));
  });

  test('a configuration change bumps the conf version', async () => {
    const store = new MemoryStore();
    const machine = await open(store);
    await machine.applyConfState(1n, 1n, create(ConfStateSchema, { voters: [1n] }));
    await machine.applyConfState(2n, 1n, create(ConfStateSchema, { voters: [1n, 2n] }));
    expect(machine.descriptor.epoch?.confVersion).toBe(2n);
    expect((await open(store)).descriptor.epoch?.confVersion).toBe(2n);
  });
});
