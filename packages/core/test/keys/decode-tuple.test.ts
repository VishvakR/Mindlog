import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { ByteWriter, appendTuple, appendVersion, decodeTuple, encodeTuple } from '@mindlog/core';
import { tuple, unwrap } from './helpers.js';

const bytes = (...values: number[]) => Uint8Array.from(values);

describe('decodeTuple', () => {
  test('round-trips every encodable tuple', () => {
    fc.assert(
      fc.property(tuple, (t) => {
        expect(unwrap(decodeTuple(unwrap(encodeTuple(t))))).toEqual({ elements: t });
      }),
      { numRuns: 5_000 },
    );
  });

  test('round-trips a trailing version suffix', () => {
    fc.assert(
      fc.property(tuple, fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), (t, version) => {
        const writer = new ByteWriter();
        unwrap(appendTuple(writer, t));
        unwrap(appendVersion(writer, version));
        expect(unwrap(decodeTuple(writer.finish()))).toEqual({ elements: t, version });
      }),
    );
  });

  test.each([
    ['unknown type code', bytes(0x99)],
    ['unterminated string', bytes(0x02, 0x61)],
    ['escape at end of input', bytes(0x01, 0x00, 0xff)],
    ['truncated integer', bytes(0x16, 0x01)],
    ['non-canonical positive integer', bytes(0x15, 0x00)],
    ['non-canonical negative integer', bytes(0x13, 0xff)],
    ['truncated double', bytes(0x21, 0x80, 0x00)],
    ['invalid UTF-8', bytes(0x02, 0xc3, 0x28, 0x00)],
    ['version not at the end', bytes(0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0x00)],
    ['short version', bytes(0x40, 0xff)],
  ])('rejects %s', (_name, input) => {
    const result = decodeTuple(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('KEY_DECODE_FAILED');
  });

  test('never throws on arbitrary bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 40 }), (input) => {
        expect(() => decodeTuple(input)).not.toThrow();
      }),
      { numRuns: 5_000 },
    );
  });
});
