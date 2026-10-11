import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Result } from '@mindlog/core';
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from '@mindlog/core';

const result = fc.oneof(
  fc.integer().map((v) => ok(v) as Result<number, string>),
  fc.string().map((e) => err(e) as Result<number, string>),
);

describe('Result', () => {
  test('ok and err are distinguished by isOk / isErr', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isOk(err('x'))).toBe(false);
    expect(isErr(err('x'))).toBe(true);
  });

  test('unwrapOr returns the value or the fallback', () => {
    expect(unwrapOr(ok(3), 0)).toBe(3);
    expect(unwrapOr(err('boom') as Result<number, string>, 0)).toBe(0);
  });

  test('mapErr only touches failures', () => {
    expect(mapErr(ok(1), (e: string) => e.length)).toEqual(ok(1));
    expect(mapErr(err('four'), (e) => e.length)).toEqual(err(4));
  });

  test('map preserves identity (functor law)', () => {
    fc.assert(
      fc.property(result, (r) => {
        expect(map(r, (x) => x)).toEqual(r);
      }),
    );
  });

  test('map composes (functor law)', () => {
    const f = (x: number) => x + 1;
    const g = (x: number) => x * 2;
    fc.assert(
      fc.property(result, (r) => {
        expect(map(map(r, f), g)).toEqual(map(r, (x) => g(f(x))));
      }),
    );
  });

  test('andThen satisfies the monad laws', () => {
    const f = (x: number): Result<number, string> => (x % 2 === 0 ? ok(x / 2) : err('odd'));
    const g = (x: number): Result<number, string> => (x > 0 ? ok(x - 1) : err('non-positive'));
    fc.assert(
      fc.property(fc.integer(), result, (x, r) => {
        expect(andThen(ok(x), f)).toEqual(f(x));
        expect(andThen(r, ok)).toEqual(r);
        expect(andThen(andThen(r, f), g)).toEqual(andThen(r, (v) => andThen(f(v), g)));
      }),
    );
  });
});
