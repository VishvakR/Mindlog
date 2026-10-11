import { describe, expect, test } from 'vitest';
import type { DomainEvent, EventBus } from '@mindlog/eventbus';

const split: DomainEvent = { type: 'RangeSplit', parent: 1n, left: 2n, right: 3n };
const health: DomainEvent = { type: 'ModelServiceHealth', up: false };

/** Behaviour every EventBus implementation must have. */
export function describeEventBusContract(name: string, make: () => EventBus): void {
  describe(`EventBus contract: ${name}`, () => {
    test('delivers an event only to handlers of its type', () => {
      const bus = make();
      const seen: string[] = [];
      bus.subscribe('RangeSplit', (e) => {
        seen.push(`split:${e.left}`);
      });
      bus.subscribe('ModelServiceHealth', (e) => {
        seen.push(`health:${e.up}`);
      });
      bus.publish(split);
      expect(seen).toEqual(['split:2']);
    });

    test('delivers synchronously, in subscription order', () => {
      const bus = make();
      const seen: number[] = [];
      for (const n of [1, 2, 3]) {
        bus.subscribe('RangeSplit', () => {
          seen.push(n);
        });
      }
      bus.publish(split);
      expect(seen).toEqual([1, 2, 3]);
    });

    test('unsubscribe stops delivery and is idempotent', () => {
      const bus = make();
      let calls = 0;
      const off = bus.subscribe('ModelServiceHealth', () => {
        calls++;
      });
      bus.publish(health);
      off();
      off();
      bus.publish(health);
      expect(calls).toBe(1);
    });

    test('a throwing handler does not stop other handlers or the publisher', () => {
      const bus = make();
      const seen: string[] = [];
      bus.subscribe('RangeSplit', () => {
        throw new Error('handler bug');
      });
      bus.subscribe('RangeSplit', () => {
        seen.push('second');
      });
      expect(() => {
        bus.publish(split);
      }).not.toThrow();
      expect(seen).toEqual(['second']);
    });

    test('a rejecting async handler does not surface to the publisher', async () => {
      const bus = make();
      bus.subscribe('RangeSplit', () => Promise.reject(new Error('async bug')));
      expect(() => {
        bus.publish(split);
      }).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    test('subscribing during dispatch takes effect from the next publish', () => {
      const bus = make();
      let late = 0;
      bus.subscribe('RangeSplit', () => {
        bus.subscribe('RangeSplit', () => {
          late++;
        });
      });
      bus.publish(split);
      expect(late).toBe(0);
      bus.publish(split);
      expect(late).toBe(1);
    });
  });
}
