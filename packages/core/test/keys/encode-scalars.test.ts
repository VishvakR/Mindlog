import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { TupleElement } from '@mindlog/core';
import { encodeTuple } from '@mindlog/core';
import { compareBytes, compareDoubles, hex, unwrap } from './helpers.js';

const enc = (v: TupleElement) => unwrap(encodeTuple([v]));

describe('encodeTuple: booleans and doubles', () => {
  test('booleans encode as FDB false/true codes', () => {
    expect(hex(enc(false))).toBe('26');
    expect(hex(enc(true))).toBe('27');
  });

  test('doubles use the IEEE sign-flip transform', () => {
    expect(hex(enc(1))).toBe('21 bf f0 00 00 00 00 00 00');
    expect(hex(enc(-42))).toBe('21 3f ba ff ff ff ff ff ff');
    expect(hex(enc(0))).toBe('21 80 00 00 00 00 00 00 00');
    expect(hex(enc(-0))).toBe('21 7f ff ff ff ff ff ff ff');
  });

  test('NaN is canonical and sorts after +Infinity', () => {
    const nan = enc(Number.NaN);
    expect(nan).toEqual(enc(0 / 0));
    expect(compareBytes(enc(Number.POSITIVE_INFINITY), nan)).toBe(-1);
  });

  test('byte order equals IEEE total order', () => {
    const double = fc.double();
    fc.assert(
      fc.property(double, double, (a, b) => {
        expect(compareBytes(enc(a), enc(b))).toBe(compareDoubles(a, b));
      }),
      { numRuns: 2_000 },
    );
  });

  test('types sort null < bytes < string < integer < double < false < true', () => {
    const ladder: TupleElement[] = [null, new Uint8Array([0xff]), '\u{10ffff}', 2n ** 64n - 1n];
    ladder.push(Number.NaN, false, true);
    for (let i = 1; i < ladder.length; i++) {
      expect(compareBytes(enc(ladder[i - 1] ?? null), enc(ladder[i] ?? null))).toBe(-1);
    }
  });
});
