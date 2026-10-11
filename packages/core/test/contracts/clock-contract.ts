import { describe, expect, test } from 'vitest';
import type { Clock } from '@mindlog/core';

/** Behaviour every Clock implementation must have. */
export function describeClockContract(name: string, make: () => Clock): void {
  describe(`Clock contract: ${name}`, () => {
    test('now() is a plausible epoch-millisecond bigint', () => {
      const now = make().now();
      expect(typeof now).toBe('bigint');
      expect(now).toBeGreaterThanOrEqual(0n);
    });

    test('monotonic() never decreases', () => {
      const clock = make();
      let previous = clock.monotonic();
      for (let i = 0; i < 1_000; i++) {
        const current = clock.monotonic();
        expect(current).toBeGreaterThanOrEqual(previous);
        previous = current;
      }
    });
  });
}
