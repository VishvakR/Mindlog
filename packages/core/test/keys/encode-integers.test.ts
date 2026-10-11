import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { encodeTuple } from '@mindlog/core';
import { compareBytes, hex, unwrap } from './helpers.js';

const MAX = 2n ** 64n - 1n;
const enc = (v: bigint) => unwrap(encodeTuple([v]));

describe('encodeTuple: integers', () => {
  test('matches the FoundationDB tuple spec vectors', () => {
    expect(hex(enc(0n))).toBe('14');
    expect(hex(enc(42n))).toBe('15 2a');
    expect(hex(enc(-1n))).toBe('13 fe');
    expect(hex(enc(-5_551_212n))).toBe('11 ab 4b 93');
    expect(hex(enc(2n ** 40n))).toBe('1a 01 00 00 00 00 00');
  });

  test('stays ordered across every byte-length boundary', () => {
    const ladder: bigint[] = [0n];
    for (let n = 1n; n <= 8n; n++) ladder.push(2n ** (8n * n) - 1n, 2n ** (8n * n));
    const values = [...new Set([...ladder, ...ladder.map((v) => -v)])]
      .filter((v) => v >= -MAX && v <= MAX)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (let i = 1; i < values.length; i++) {
      const lo = values[i - 1] ?? 0n;
      const hi = values[i] ?? 0n;
      expect(compareBytes(enc(lo), enc(hi)), `${lo} < ${hi}`).toBe(-1);
    }
  });

  test('byte order equals numeric order', () => {
    const int = fc.bigInt({ min: -MAX, max: MAX });
    fc.assert(
      fc.property(int, int, (a, b) => {
        const expected = a < b ? -1 : a > b ? 1 : 0;
        expect(compareBytes(enc(a), enc(b))).toBe(expected);
      }),
      { numRuns: 2_000 },
    );
  });

  test('uses at most 9 bytes', () => {
    expect(enc(MAX)).toHaveLength(9);
    expect(enc(-MAX)).toHaveLength(9);
  });

  test('rejects magnitudes beyond 64 bits', () => {
    for (const v of [MAX + 1n, -(MAX + 1n)]) {
      const result = encodeTuple([v]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('KEY_ENCODING_OUT_OF_RANGE');
    }
  });
});
