import { describe, expect, test } from 'vitest';
import { ManualClock, MemoryLogger, MemoryMetrics, mindlogError } from '@mindlog/core';
import type { DomainEvent } from '@mindlog/eventbus';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { FakeModels, GuardedModels } from '@mindlog/models-client';

function setup(): {
  fake: FakeModels;
  guarded: GuardedModels;
  clock: ManualClock;
  events: DomainEvent[];
  metrics: MemoryMetrics;
} {
  const fake = new FakeModels();
  const clock = new ManualClock(1_000n);
  const metrics = new MemoryMetrics();
  const bus = new InMemoryEventBus({ logger: new MemoryLogger(), metrics });
  const events: DomainEvent[] = [];
  bus.subscribe('ModelServiceHealth', (e) => {
    events.push(e);
  });
  const guarded = new GuardedModels(fake, {
    clock,
    bus,
    metrics,
    failures: 3,
    openMs: 10_000,
  });
  return { fake, guarded, clock, events, metrics };
}

describe('GuardedModels (circuit breaker)', () => {
  test('opens after N failures and then fails fast without calling the service', async () => {
    const { fake, guarded, events } = setup();
    fake.down = true;
    for (let i = 0; i < 3; i++) {
      const r = await guarded.embed(['x'], 'query');
      expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
    }
    expect(events).toEqual([{ type: 'ModelServiceHealth', up: false }]);
    const calls = fake.calls;
    const fast = await guarded.embed(['x'], 'query');
    expect(!fast.ok && fast.error.message).toMatch(/circuit open/);
    expect(fake.calls).toBe(calls);
    expect(guarded.open).toBe(true);
  });

  test('a half-open probe closes the breaker once the service is back', async () => {
    const { fake, guarded, clock, events } = setup();
    fake.down = true;
    for (let i = 0; i < 3; i++) await guarded.embed(['x'], 'query');
    fake.down = false;
    clock.advance(10_001n);
    const probe = await guarded.embed(['x'], 'query');
    expect(probe.ok).toBe(true);
    expect(guarded.open).toBe(false);
    expect(events.map((e) => e.type === 'ModelServiceHealth' && e.up)).toEqual([false, true]);
  });

  test('a failed probe keeps it open for another period', async () => {
    const { fake, guarded, clock } = setup();
    fake.down = true;
    for (let i = 0; i < 3; i++) await guarded.embed(['x'], 'query');
    clock.advance(10_001n);
    await guarded.embed(['x'], 'query');
    const calls = fake.calls;
    await guarded.embed(['x'], 'query');
    expect(fake.calls).toBe(calls);
  });

  test('BUSY is returned but does not count as a failure', async () => {
    const { fake, guarded } = setup();
    fake.failWith = mindlogError('BUSY', 'queue full');
    for (let i = 0; i < 5; i++) {
      const r = await guarded.embed(['x'], 'query');
      expect(!r.ok && r.error.code).toBe('BUSY');
    }
    expect(guarded.open).toBe(false);
  });

  test('records latency and errors per method', async () => {
    const { fake, guarded, metrics } = setup();
    await guarded.rerank('q', ['d']);
    fake.down = true;
    await guarded.rerank('q', ['d']);
    expect(
      metrics.value('mindlog_models_errors_total', { method: 'rerank', code: 'UNAVAILABLE' }),
    ).toBe(1);
    expect(
      metrics.observations('mindlog_models_call_latency_seconds', { method: 'rerank' }),
    ).toHaveLength(2);
  });
});
