import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { KeyFamily, KeyRange } from '@mindlog/core';
import {
  KeyFamily as Families,
  decodeKey,
  encodeKey,
  keyPrefix,
  prefixRange,
  versionsRange,
} from '@mindlog/core';
import { compareBytes, hex, tuple, unwrap } from './helpers.js';

const family = fc.constantFrom(...Object.values(Families));
const tenant = fc.string({ minLength: 1, maxLength: 8 });

function inRange(key: Uint8Array, range: KeyRange): boolean {
  return compareBytes(range.start, key) <= 0 && compareBytes(key, range.end) < 0;
}

describe('encodeKey', () => {
  test('lays out tenant, family, tuple and version as tuple elements', () => {
    const key = unwrap(encodeKey({ tenant: 'acme', family: 'k', tuple: ['user:1'], version: 7n }));
    expect(hex(key)).toBe(
      '02 61 63 6d 65 00 02 6b 00 02 75 73 65 72 3a 31 00 40 ff ff ff ff ff ff ff f8',
    );
  });

  test('decodeKey round-trips', () => {
    fc.assert(
      fc.property(
        tenant,
        family,
        tuple,
        fc.option(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { nil: undefined }),
        (t, f, tup, version) => {
          const parts =
            version === undefined
              ? { tenant: t, family: f, tuple: tup }
              : { tenant: t, family: f, tuple: tup, version };
          expect(unwrap(decodeKey(unwrap(encodeKey(parts))))).toEqual(parts);
        },
      ),
    );
  });

  test('rejects an empty tenant or an unknown family', () => {
    expect(encodeKey({ tenant: '', family: 'k', tuple: [] }).ok).toBe(false);
    expect(encodeKey({ tenant: 'a', family: 'z' as KeyFamily, tuple: [] }).ok).toBe(false);
    expect(keyPrefix('a', undefined, ['x']).ok).toBe(false);
  });

  test('decodeKey rejects tuples without a tenant and family', () => {
    expect(decodeKey(Uint8Array.of(0x14)).ok).toBe(false);
    expect(decodeKey(unwrap(keyPrefix('acme'))).ok).toBe(false);
  });
});

describe('prefix ranges', () => {
  test('a tenant range never contains another tenant', () => {
    fc.assert(
      fc.property(tenant, tenant, family, tuple, (a, b, f, tup) => {
        fc.pre(a !== b);
        const key = unwrap(encodeKey({ tenant: b, family: f, tuple: tup }));
        expect(inRange(key, prefixRange(unwrap(keyPrefix(a))))).toBe(false);
      }),
    );
  });

  test('a prefix range contains every key that extends the prefix', () => {
    fc.assert(
      fc.property(tenant, family, tuple, tuple, (t, f, head, rest) => {
        const range = prefixRange(unwrap(keyPrefix(t, f, head)));
        const key = unwrap(encodeKey({ tenant: t, family: f, tuple: [...head, ...rest] }));
        const versioned = unwrap(encodeKey({ tenant: t, family: f, tuple: head, version: 3n }));
        expect(inRange(key, range)).toBe(true);
        expect(inRange(versioned, range)).toBe(true);
      }),
    );
  });

  test('versionsRange holds exactly the versions of one key', () => {
    const base = { tenant: 'acme', family: Families.KV, tuple: ['a'] };
    const range = versionsRange(unwrap(encodeKey(base)));
    expect(inRange(unwrap(encodeKey({ ...base, version: 0n })), range)).toBe(true);
    expect(inRange(unwrap(encodeKey({ ...base, version: 2n ** 64n - 1n })), range)).toBe(true);
    expect(inRange(unwrap(encodeKey(base)), range)).toBe(false);
    expect(inRange(unwrap(encodeKey({ ...base, tuple: ['a', 1n], version: 1n })), range)).toBe(
      false,
    );
  });
});
