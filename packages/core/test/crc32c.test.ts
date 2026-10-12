import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { crc32c } from '@mindlog/core';

const ascii = (s: string) => new TextEncoder().encode(s);

describe('crc32c', () => {
  test('matches the standard check value and RFC 3720 vectors', () => {
    expect(crc32c(ascii('123456789'))).toBe(0xe3069283);
    expect(crc32c(new Uint8Array(32))).toBe(0x8a9136aa);
    expect(crc32c(new Uint8Array(32).fill(0xff))).toBe(0x62a8ab43);
    expect(crc32c(new Uint8Array())).toBe(0);
  });

  test('can be computed in pieces', () => {
    fc.assert(
      fc.property(fc.uint8Array(), fc.uint8Array(), (a, b) => {
        const whole = new Uint8Array([...a, ...b]);
        expect(crc32c(b, crc32c(a))).toBe(crc32c(whole));
      }),
    );
  });

  test('detects any single-bit flip', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 1 }),
        fc.nat(),
        fc.integer({ min: 0, max: 7 }),
        (data, at, bit) => {
          const flipped = data.slice();
          const i = at % data.length;
          flipped[i] = (flipped[i] ?? 0) ^ (1 << bit);
          expect(crc32c(flipped)).not.toBe(crc32c(data));
        },
      ),
    );
  });
});
