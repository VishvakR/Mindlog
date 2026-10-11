import { describe, expect, expectTypeOf, test } from 'vitest';
import type { DomainEvent, EventOf } from '@mindlog/eventbus';
import { DOMAIN_EVENT_TYPES } from '@mindlog/eventbus';

describe('domain events', () => {
  test('DOMAIN_EVENT_TYPES lists every event type once', () => {
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
    expect(DOMAIN_EVENT_TYPES).toHaveLength(8);
  });

  test('EventOf narrows the union by type', () => {
    expectTypeOf<EventOf<'RangeSplit'>>().toEqualTypeOf<
      Extract<DomainEvent, { type: 'RangeSplit' }>
    >();
    expectTypeOf<EventOf<'LeaderChanged'>['rangeId']>().toEqualTypeOf<bigint>();
  });
});
