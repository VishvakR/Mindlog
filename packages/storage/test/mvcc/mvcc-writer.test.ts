import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { encodeKey } from '@mindlog/core';
import {
  MemoryStore,
  MvccWriter,
  compareBytes,
  decodeVersionValue,
  keyAfter,
  parseVersionedKey,
  versionedKey,
} from '@mindlog/storage';

const utf8 = new TextEncoder();
const logical = (k: string) => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: [k] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const index = fc.bigInt({ min: 0n, max: 2n ** 64n - 1n });

describe('versioned keys', () => {
  test('parse inverts versionedKey', () => {
    fc.assert(
      fc.property(fc.string(), index, (k, i) => {
        const parsed = parseVersionedKey(versionedKey(logical(k), i));
        expect(parsed?.index).toBe(i);
        expect(parsed?.logical).toEqual(logical(k));
      }),
    );
  });

  test('a newer version sorts before an older one', () => {
    fc.assert(
      fc.property(index, index, (a, b) => {
        fc.pre(a !== b);
        const order = compareBytes(versionedKey(logical('x'), a), versionedKey(logical('x'), b));
        expect(order).toBe(a > b ? -1 : 1);
      }),
    );
  });

  test('keyAfter is past every version and every extension of a key', () => {
    const base = logical('x');
    const after = keyAfter(base);
    expect(compareBytes(versionedKey(base, 0n), after)).toBe(-1);
    const extension = encodeKey({ tenant: 't', family: 'k', tuple: ['x', 1n, 'h', 'f'] });
    if (!extension.ok) throw new Error(extension.error.message);
    expect(compareBytes(versionedKey(extension.value, 0n), after)).toBe(-1);
    expect(compareBytes(after, logical('x\u0000'))).toBe(-1);
  });

  test('keys without a version suffix do not parse', () => {
    expect(parseVersionedKey(logical('x'))).toBeUndefined();
    expect(parseVersionedKey(Uint8Array.of(1, 2))).toBeUndefined();
  });
});

describe('MvccWriter', () => {
  test('writes live values and tombstones at its index', async () => {
    const store = new MemoryStore();
    const batch = store.batch();
    const writer = new MvccWriter(batch, 7n);
    writer.put(logical('a'), utf8.encode('v'));
    writer.delete(logical('b'));
    await batch.write();
    const a = await store.get(versionedKey(logical('a'), 7n));
    const b = await store.get(versionedKey(logical('b'), 7n));
    expect(a && decodeVersionValue(a)).toEqual(utf8.encode('v'));
    expect(b && decodeVersionValue(b)).toBeUndefined();
    expect(writer.index).toBe(7n);
  });

  test('corrupt envelopes throw', () => {
    expect(() => decodeVersionValue(Uint8Array.of(9))).toThrow(/corrupt/);
    expect(() => decodeVersionValue(Uint8Array.of(0, 1))).toThrow(/corrupt/);
  });
});
