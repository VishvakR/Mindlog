import { describe, expect, test } from 'vitest';
import { MemoryLogger, MemoryMetrics } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { describeEventBusContract } from './contracts/event-bus-contract.js';

describeEventBusContract(
  'InMemoryEventBus',
  () => new InMemoryEventBus({ logger: new MemoryLogger(), metrics: new MemoryMetrics() }),
);

describe('InMemoryEventBus', () => {
  function setup() {
    const logger = new MemoryLogger();
    const metrics = new MemoryMetrics();
    return { logger, metrics, bus: new InMemoryEventBus({ logger, metrics }) };
  }

  test('counts published events by type', () => {
    const { metrics, bus } = setup();
    bus.publish({ type: 'ModelServiceHealth', up: true });
    bus.publish({ type: 'ModelServiceHealth', up: false });
    expect(
      metrics.value('mindlog_eventbus_events_published_total', { type: 'ModelServiceHealth' }),
    ).toBe(2);
  });

  test('logs and counts failing handlers, sync and async', async () => {
    const { logger, metrics, bus } = setup();
    bus.subscribe('LeaderChanged', () => {
      throw new Error('sync bug');
    });
    bus.subscribe('LeaderChanged', () => Promise.reject(new Error('async bug')));
    bus.publish({ type: 'LeaderChanged', rangeId: 4n, leader: 'node-2' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(metrics.value('mindlog_eventbus_handler_errors_total', { type: 'LeaderChanged' })).toBe(
      2,
    );
    expect(logger.entries.map((e) => e.fields['error'])).toEqual(['sync bug', 'async bug']);
    expect(logger.entries[0]?.fields).toMatchObject({
      module: 'eventbus',
      eventType: 'LeaderChanged',
    });
  });

  test('unsubscribing one handler keeps the others', () => {
    const { bus } = setup();
    const seen: string[] = [];
    const offA = bus.subscribe('RangeSplit', () => {
      seen.push('a');
    });
    bus.subscribe('RangeSplit', () => {
      seen.push('b');
    });
    offA();
    bus.publish({ type: 'RangeSplit', parent: 1n, left: 2n, right: 3n });
    expect(seen).toEqual(['b']);
  });
});
