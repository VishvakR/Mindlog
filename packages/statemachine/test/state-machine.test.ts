import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { ManualClock, MemoryLogger, MemoryMetrics, packHlc } from '@mindlog/core';
import type { DomainEvent } from '@mindlog/eventbus';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { CommandSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import { ApplyHandlerRegistry, StateMachine } from '@mindlog/statemachine';
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
  });
  return { store, machine, seen, metrics };
}

const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);

describe('StateMachine', () => {
  test('applies commands in order and persists the applied index', async () => {
    const { store, machine, seen, metrics } = await setup();
    expect(machine.appliedIndex).toBe(0n);
    await machine.apply(1n, writeCommand(['INCR', 'n']));
    await machine.apply(2n, writeCommand(['INCR', 'n']));
    expect(text(await new MvccReader(store).get(counterKey('n')))).toBe('2');
    expect(machine.appliedIndex).toBe(2n);
    expect((await setup(store)).machine.appliedIndex).toBe(2n);
    expect(seen.map((e) => (e.type === 'CommandApplied' ? e.index : -1n))).toEqual([1n, 2n]);
    expect(metrics.value('mindlog_statemachine_applied_total', { body: 'kvWrite' })).toBe(2);
  });

  test('refuses out-of-order indexes (fail-stop)', async () => {
    const { machine } = await setup();
    await expect(machine.apply(2n, writeCommand(['INCR', 'n']))).rejects.toThrow(/out of order/);
  });

  test('a repeated request id returns the original result without re-applying', async () => {
    const { store, machine } = await setup();
    const first = await machine.apply(1n, writeCommand(['INCR', 'n'], 'same'));
    const retry = await machine.apply(2n, writeCommand(['INCR', 'n'], 'same'));
    expect(retry).toEqual(first);
    expect(text(await new MvccReader(store).get(counterKey('n')))).toBe('1');
    expect(machine.appliedIndex).toBe(2n);
  });

  test('records deterministic failures as results and still advances', async () => {
    const { machine } = await setup();
    const bad = await machine.apply(1n, writeCommand(['NOPE', 'n']));
    expect(bad.outcome.case).toBe('error');
    const empty = await machine.apply(2n, create(CommandSchema, { requestId: Uint8Array.of(9) }));
    expect(empty.outcome.case === 'error' && empty.outcome.value.code).toBe('INVALID_ARGUMENT');
    const unhandled = await machine.apply(
      3n,
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
      await machine.apply(1n, writeCommand(['STAMP', 's'], 'r1', hlc));
      await machine.apply(2n, writeCommand(['ROLL', 'r'], 'r2'));
    }
    const read = async (s: KvStore, name: string) =>
      text(await new MvccReader(s).get(counterKey(name)));
    expect(await read(a.store, 's')).toBe('1760000000123');
    expect(await read(a.store, 'r')).toBe(await read(b.store, 'r'));
  });
});
