import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Random } from '@mindlog/core';
import { ManualClock, SeededRandom, UlidGenerator, isUlid, ulidTime } from '@mindlog/core';

const T0 = 1_760_000_000_000n;

describe('UlidGenerator', () => {
  test('produces 26-char Crockford base32 ids carrying the clock time', () => {
    const clock = new ManualClock(T0);
    const id = new UlidGenerator(clock, new SeededRandom(1n)).next();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
    expect(ulidTime(id)).toEqual({ ok: true, value: T0 });
  });

  test('is reproducible from the same seed and clock', () => {
    const make = () => new UlidGenerator(new ManualClock(T0), new SeededRandom(9n));
    const a = make();
    const b = make();
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
  });

  test('ids strictly increase even when the clock stalls or jumps backwards', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -50, max: 50 }), { minLength: 1, maxLength: 200 }),
        fc.bigInt({ min: 0n, max: 2n ** 64n }),
        (steps, seed) => {
          const clock = new ManualClock(T0);
          const ulids = new UlidGenerator(clock, new SeededRandom(seed));
          let previous = ulids.next();
          for (const step of steps) {
            clock.setWall(clock.now() + BigInt(step));
            const current = ulids.next();
            expect(current > previous).toBe(true);
            previous = current;
          }
        },
      ),
    );
  });

  test('borrows the next millisecond when the random part overflows', () => {
    const maxed: Random = {
      next: () => 0.5,
      nextUint32: () => 0xffffffff,
      fillBytes: (b) => b.fill(0xff),
    };
    const ulids = new UlidGenerator(new ManualClock(T0), maxed);
    ulids.next();
    const second = ulids.next();
    expect(ulidTime(second)).toEqual({ ok: true, value: T0 + 1n });
  });

  test('rejects timestamps beyond 48 bits', () => {
    const ulids = new UlidGenerator(new ManualClock(2n ** 48n), new SeededRandom(1n));
    expect(() => ulids.next()).toThrow(RangeError);
  });
});

describe('ulidTime', () => {
  test('rejects malformed ids', () => {
    expect(ulidTime('not-a-ulid').ok).toBe(false);
    expect(ulidTime('8ZZZZZZZZZZZZZZZZZZZZZZZZZ').ok).toBe(false);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe(true);
    expect(isUlid('01ARZ3NDEKTSV4RRFFQ69G5FAI')).toBe(false);
  });

  test('decodes the timestamp of the ULID spec example', () => {
    expect(ulidTime('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toEqual({ ok: true, value: 1_469_922_850_259n });
  });
});
