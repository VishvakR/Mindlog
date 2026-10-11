import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Tuple } from '@mindlog/core';
import { ByteWriter, VERSION_SUFFIX_LENGTH, appendTuple, appendVersion } from '@mindlog/core';
import { compareBytes, hex, unwrap } from './helpers.js';

function versioned(tuple: Tuple, index: bigint): Uint8Array {
  const writer = new ByteWriter();
  unwrap(appendTuple(writer, tuple));
  unwrap(appendVersion(writer, index));
  return writer.finish();
}

describe('appendVersion', () => {
  test('writes the marker and the inverted index', () => {
    const writer = new ByteWriter();
    unwrap(appendVersion(writer, 1n));
    expect(hex(writer.finish())).toBe('40 ff ff ff ff ff ff ff fe');
    expect(writer.length).toBe(VERSION_SUFFIX_LENGTH);
  });

  test('newer versions of a key sort first', () => {
    const index = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });
    fc.assert(
      fc.property(fc.string(), index, index, (key, a, b) => {
        const expected = a > b ? -1 : a < b ? 1 : 0;
        expect(compareBytes(versioned([key], a), versioned([key], b))).toBe(expected);
      }),
    );
  });

  test('all versions of a key are contiguous', () => {
    const lowest = versioned(['k'], 2n ** 64n - 1n);
    const highest = versioned(['k'], 0n);
    for (const other of [
      versioned(['k', 0n], 5n),
      versioned(['k\u0000'], 5n),
      versioned(['j'], 5n),
    ]) {
      const inside = compareBytes(lowest, other) <= 0 && compareBytes(other, highest) <= 0;
      expect(inside).toBe(false);
    }
  });

  test('rejects versions outside uint64', () => {
    for (const v of [-1n, 2n ** 64n]) {
      const result = appendVersion(new ByteWriter(), v);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('KEY_ENCODING_OUT_OF_RANGE');
    }
  });
});
