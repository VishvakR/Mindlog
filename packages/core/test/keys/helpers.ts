import fc from 'fast-check';
import { expect } from 'vitest';
import type { Result, TupleElement } from '@mindlog/core';

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function unwrap<T>(result: Result<T, unknown>): T {
  if (!result.ok) expect.fail(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

/** Unsigned lexicographic byte comparison, as LevelDB's default comparator. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Arbitrary tuple element covering every supported type and edge values. */
export const tupleElement: fc.Arbitrary<TupleElement> = fc.oneof(
  fc.constant(null),
  fc.uint8Array({ maxLength: 12 }),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  fc.constantFrom('', '\u0000', 'a\u0000', 'a', '\u{10ffff}'),
  fc.bigInt({ min: -(2n ** 64n - 1n), max: 2n ** 64n - 1n }),
  fc.bigInt({ min: -300n, max: 300n }),
  fc.double(),
  fc.boolean(),
);

export const tuple = fc.array(tupleElement, { maxLength: 6 });
