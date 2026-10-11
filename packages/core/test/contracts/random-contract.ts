import { describe, expect, test } from 'vitest';
import type { Random } from '@mindlog/core';

/** Behaviour every Random implementation must have. */
export function describeRandomContract(name: string, make: () => Random): void {
  describe(`Random contract: ${name}`, () => {
    test('next() stays in [0, 1) and is roughly uniform', () => {
      const random = make();
      let sum = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        const x = random.next();
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(1);
        sum += x;
      }
      expect(sum / n).toBeGreaterThan(0.48);
      expect(sum / n).toBeLessThan(0.52);
    });

    test('nextUint32() returns unsigned 32-bit integers', () => {
      const random = make();
      for (let i = 0; i < 1_000; i++) {
        const v = random.nextUint32();
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(0xffffffff);
      }
    });

    test('fillBytes() fills buffers of every length', () => {
      const random = make();
      for (let len = 0; len <= 33; len++) {
        const buf = new Uint8Array(len);
        random.fillBytes(buf);
        expect(buf.length).toBe(len);
      }
      const big = new Uint8Array(4_096);
      random.fillBytes(big);
      expect(new Set(big).size).toBeGreaterThan(200);
    });
  });
}
