import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { formatDouble, parseFloat64, parseInteger } from '@mindlog/kv';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('parseInteger (Valkey string2ll rules)', () => {
  test.each([
    ['0', 0n],
    ['-1', -1n],
    ['17179869184', 17_179_869_184n],
    ['9223372036854775807', 2n ** 63n - 1n],
    ['-9223372036854775808', -(2n ** 63n)],
  ])('accepts %s', (text, expected) => {
    expect(parseInteger(bytes(text))).toBe(expected);
  });

  test.each(['', ' 11', '11 ', '+1', '01', '-0', '1.0', 'abc', '9223372036854775808', '0x10'])(
    'rejects %j',
    (text) => {
      expect(parseInteger(bytes(text))).toBeUndefined();
    },
  );

  test('round-trips every int64', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }), (n) => {
        expect(parseInteger(bytes(n.toString()))).toBe(n);
      }),
    );
  });
});

describe('parseFloat64', () => {
  test('accepts decimals, exponents and infinities', () => {
    expect(parseFloat64(bytes('1.5'))).toBe(1.5);
    expect(parseFloat64(bytes('-.5e2'))).toBe(-50);
    expect(parseFloat64(bytes('+inf'))).toBe(Number.POSITIVE_INFINITY);
    expect(parseFloat64(bytes('-INF'))).toBe(Number.NEGATIVE_INFINITY);
  });

  test.each(['nan', 'abc', '1.5x', ' 1', ''])('rejects %j', (text) => {
    expect(parseFloat64(bytes(text))).toBeUndefined();
  });

  test('formatDouble round-trips through parseFloat64', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true }), (d) => {
        expect(parseFloat64(bytes(formatDouble(d)))).toBe(d);
      }),
    );
  });
});
