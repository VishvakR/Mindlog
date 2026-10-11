import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { ByteWriter, encodeTuple } from '@mindlog/core';
import { compareBytes, hex, unwrap } from './helpers.js';

const utf8 = new TextEncoder();

describe('ByteWriter', () => {
  test('grows past its initial capacity', () => {
    const writer = new ByteWriter(2);
    for (let i = 0; i < 100; i++) writer.byte(i);
    writer.bytes(new Uint8Array([1, 2, 3]));
    expect(writer.length).toBe(103);
    expect(writer.finish()[99]).toBe(99);
  });
});

describe('encodeTuple: null, bytes, strings', () => {
  test('matches the FoundationDB tuple spec vectors', () => {
    expect(hex(unwrap(encodeTuple([null])))).toBe('00');
    expect(hex(unwrap(encodeTuple([utf8.encode('foo\x00bar')])))).toBe(
      '01 66 6f 6f 00 ff 62 61 72 00',
    );
    expect(hex(unwrap(encodeTuple(['FÔO\u0000bar'])))).toBe('02 46 c3 94 4f 00 ff 62 61 72 00');
  });

  test('concatenates elements so a tuple prefix is a byte prefix', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), fc.array(fc.string()), (a, b) => {
        const whole = unwrap(encodeTuple([...a, ...b]));
        const prefix = unwrap(encodeTuple(a));
        expect(whole.subarray(0, prefix.length)).toEqual(prefix);
      }),
    );
  });

  test('byte order equals UTF-8 (code point) order for strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), fc.string({ unit: 'grapheme' }), (a, b) => {
        const byBytes = compareBytes(unwrap(encodeTuple([a])), unwrap(encodeTuple([b])));
        const byUtf8 = compareBytes(utf8.encode(a), utf8.encode(b));
        expect(byBytes).toBe(byUtf8);
      }),
    );
  });

  test('embedded zero bytes still sort correctly', () => {
    const a = unwrap(encodeTuple([new Uint8Array([0x61, 0x00])]));
    const b = unwrap(encodeTuple([new Uint8Array([0x61])]));
    const c = unwrap(encodeTuple([new Uint8Array([0x61, 0x00, 0x00])]));
    expect(compareBytes(b, a)).toBe(-1);
    expect(compareBytes(a, c)).toBe(-1);
  });

  test('rejects strings with lone surrogates', () => {
    const result = encodeTuple(['bad \ud800']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_ARGUMENT');
  });
});
