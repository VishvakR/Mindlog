import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { ManualClock, MemoryLogger, MemoryMetrics, packHlc } from '@mindlog/core';
import type { DomainEvent } from '@mindlog/eventbus';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { CommandSchema, ConfStateSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import { ApplyHandlerRegistry, StateMachine, wholeKeyspace } from '@mindlog/statemachine';
import { counterHandler, counterKey, writeCommand } from './support/counter-handler.js';

async function setup(store: KvStore = new MemoryStore()) {
  const handlers = new ApplyHandlerRegistry();
  handlers.register(counterHandler);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const events = new InMemoryEventBus({ logger, metrics });
  const seen: DomainEvent[] = [];
  events.subscribe('CommandApplied', (e) => {
    seen.push(e);
  });
  const machine = await StateMachine.open({
    store,
    handlers,
    events,
    clock: new ManualClock(),
    logger,
    metrics,
    descriptor: wholeKeyspace(1n),
  });
  return { store, machine, seen, metrics };
}

const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);

describe('StateMachine', () => {
  test('applies commands in order and persists the applied index', async () => {
    const { store, machine, seen, metrics } = await setup();
    expect(machine.appliedIndex).toBe(0n);
    await machine.apply(1n, 1n, writeCommand(['INCR', 'n']));
    await machine.apply(2n, 1n, writeCommand(['INCR', 'n']));
    expect(text(await new MvccReader(store).get(counterKey('n')))).toBe('2');
    expect(machine.appliedIndex).toBe(2n);
    expect((await setup(store)).machine.appliedIndex).toBe(2n);
    expect(seen.map((e) => (e.type === 'CommandApplied' ? e.index : -1n))).toEqual([1n, 2n]);
    expect(metrics.value('mindlog_statemachine_applied_total', { body: 'kvWrite' })).toBe(2);
  });

  test('refuses out-of-order indexes (fail-stop)', async () => {
    const { machine } = await setup();
    await expect(machine.apply(2n, 1n, writeCommand(['INCR', 'n']))).rejects.toThrow(
      /out of order/,
    );
  });

  test('a repeated request id returns the original result without re-applying', async () => {
    const { store, machine } = await setup();
    const first = await machine.apply(1n, 1n, writeCommand(['INCR', 'n'], 'same'));
    const retry = await machine.apply(2n, 1n, writeCommand(['INCR', 'n'], 'same'));
    expect(retry).toEqual(first);
    expect(text(await new MvccReader(store).get(counterKey('n')))).toBe('1');
    expect(machine.appliedIndex).toBe(2n);
  });

  test('records deterministic failures as results and still advances', async () => {
    const { machine } = await setup();
    const bad = await machine.apply(1n, 1n, writeCommand(['NOPE', 'n']));
    expect(bad.outcome.case).toBe('error');
    const empty = await machine.apply(
      2n,
      1n,
      create(CommandSchema, { requestId: Uint8Array.of(9) }),
    );
    expect(empty.outcome.case === 'error' && empty.outcome.value.code).toBe('INVALID_ARGUMENT');
    const unhandled = await machine.apply(
      3n,
      1n,
      create(CommandSchema, { body: { case: 'expire', value: {} } }),
    );
    expect(unhandled.outcome.case === 'error' && unhandled.outcome.value.code).toBe(
      'UNIMPLEMENTED',
    );
    expect(machine.appliedIndex).toBe(3n);
  });

  test('handlers get time from the HLC and randomness seeded by the index', async () => {
    const a = await setup();
    const b = await setup();
    const hlc = packHlc(1_760_000_000_123n, 4n);
    for (const { machine } of [a, b]) {
      await machine.apply(1n, 1n, writeCommand(['STAMP', 's'], 'r1', hlc));
      await machine.apply(2n, 1n, writeCommand(['ROLL', 'r'], 'r2'));
    }
    const read = async (s: KvStore, name: string) =>
      text(await new MvccReader(s).get(counterKey(name)));
    expect(await read(a.store, 's')).toBe('1760000000123');
    expect(await read(a.store, 'r')).toBe(await read(b.store, 'r'));
  });

  test('no-op and configuration entries advance the applied point', async () => {
    const { store, machine } = await setup();
    await machine.applyEmpty(1n, 2n);
    const conf = create(ConfStateSchema, { voters: [1n, 2n], addresses: { '1': 'a', '2': 'b' } });
    await machine.applyConfState(2n, 2n, conf);
    expect(machine.applied).toEqual({ index: 2n, term: 2n });
    expect(machine.confState).toEqual(conf);
    await expect(machine.applyEmpty(4n, 2n)).rejects.toThrow(/out of order/);
    const reopened = (await setup(store)).machine;
    expect(reopened.applied).toEqual({ index: 2n, term: 2n });
    expect(reopened.confState).toEqual(conf);
  });

  test('a snapshot replaces all state atomically and carries its applied point', async () => {
    const source = await setup();
    await source.machine.applyConfState(1n, 1n, create(ConfStateSchema, { voters: [1n] }));
    await source.machine.apply(2n, 2n, writeCommand(['INCR', 'n']));
    const snapshot = await source.machine.snapshot();
    expect(snapshot.meta).toMatchObject({ index: 2n, term: 2n, confState: { voters: [1n] } });
    const pairs = [];
    for await (const chunk of snapshot.chunks(1)) pairs.push(...chunk);
    await snapshot.release();

    const target = await setup();
    await target.machine.apply(1n, 1n, writeCommand(['INCR', 'stale']));
    await target.machine.installSnapshot(snapshot.meta, pairs);
    expect(target.machine.applied).toEqual({ index: 2n, term: 2n });
    expect(target.machine.confState.voters).toEqual([1n]);
    expect(text(await new MvccReader(target.store).get(counterKey('n')))).toBe('1');
    expect(await new MvccReader(target.store).get(counterKey('stale'))).toBeUndefined();
    await expect(
      target.machine.installSnapshot({ ...snapshot.meta, index: 9n }, pairs),
    ).rejects.toThrow(/not 9/);
  });
});
