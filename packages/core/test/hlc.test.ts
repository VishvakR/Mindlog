import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Hlc } from '@mindlog/core';
import { HybridLogicalClock, ManualClock, hlcLogical, hlcPhysical, packHlc } from '@mindlog/core';

const T0 = 1_760_000_000_000n;
const MAX_OFFSET = 500n;

function makeClock(startMs = T0) {
  const wall = new ManualClock(startMs);
  return { wall, hlc: new HybridLogicalClock(wall, { maxOffsetMs: MAX_OFFSET }) };
}

describe('packHlc', () => {
  test('round-trips physical and logical parts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 2n ** 48n - 1n }),
        fc.bigInt({ min: 0n, max: 65_535n }),
        (physical, logical) => {
          const hlc = packHlc(physical, logical);
          expect(hlcPhysical(hlc)).toBe(physical);
          expect(hlcLogical(hlc)).toBe(logical);
          expect(hlc).toBeLessThan(2n ** 64n);
        },
      ),
    );
  });

  test('orders by physical time, then logical counter', () => {
    expect(packHlc(10n, 65_535n)).toBeLessThan(packHlc(11n, 0n));
    expect(packHlc(10n, 1n)).toBeLessThan(packHlc(10n, 2n));
  });

  test('rejects out-of-range parts', () => {
    expect(() => packHlc(2n ** 48n, 0n)).toThrow(RangeError);
    expect(() => packHlc(0n, 65_536n)).toThrow(RangeError);
  });
});

describe('HybridLogicalClock', () => {
  test('follows wall time when it moves forward', () => {
    const { wall, hlc } = makeClock();
    expect(hlc.now()).toBe(packHlc(T0, 0n));
    wall.advance(5n);
    expect(hlc.now()).toBe(packHlc(T0 + 5n, 0n));
  });

  test('counts logically while wall time stalls or goes backwards', () => {
    const { wall, hlc } = makeClock();
    hlc.now();
    expect(hlc.now()).toBe(packHlc(T0, 1n));
    wall.setWall(T0 - 1_000n);
    expect(hlc.now()).toBe(packHlc(T0, 2n));
  });

  test('carries into physical time when the logical counter overflows', () => {
    const { hlc } = makeClock();
    hlc.now();
    for (let i = 0; i < 65_535; i++) hlc.now();
    expect(hlc.current()).toBe(packHlc(T0, 65_535n));
    expect(hlc.now()).toBe(packHlc(T0 + 1n, 0n));
  });

  test('update() moves past a remote timestamp from the future', () => {
    const { hlc } = makeClock();
    const remote = packHlc(T0 + 100n, 7n);
    expect(hlc.update(remote)).toEqual({ ok: true, value: packHlc(T0 + 100n, 8n) });
  });

  test('update() rejects remotes further ahead than the max offset', () => {
    const { hlc } = makeClock();
    const before = hlc.current();
    const result = hlc.update(packHlc(T0 + MAX_OFFSET + 1n, 0n));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CLOCK_OFFSET_EXCEEDED');
    expect(hlc.current()).toBe(before);
  });

  test('timestamps strictly increase and dominate every observed remote', () => {
    const event = fc.oneof(
      fc.record({ kind: fc.constant('tick' as const), step: fc.integer({ min: -200, max: 200 }) }),
      fc.record({
        kind: fc.constant('recv' as const),
        skew: fc.integer({ min: -2_000, max: 400 }),
        logical: fc.integer({ min: 0, max: 65_535 }),
      }),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 300 }), (events) => {
        const { wall, hlc } = makeClock();
        let last: Hlc = hlc.now();
        for (const e of events) {
          if (e.kind === 'tick') {
            wall.setWall(wall.now() + BigInt(e.step));
            const next = hlc.now();
            expect(next).toBeGreaterThan(last);
            last = next;
          } else {
            const remote = packHlc(wall.now() + BigInt(e.skew), BigInt(e.logical));
            const result = hlc.update(remote);
            expect(result.ok).toBe(true);
            if (result.ok) {
              expect(result.value).toBeGreaterThan(last);
              expect(result.value).toBeGreaterThan(remote);
              last = result.value;
            }
          }
        }
      }),
    );
  });
});

describe('HybridLogicalClock regressions', () => {
  // fast-check counterexample: equal physical times must still advance the counter.
  test('update() with an equal remote timestamp increments the logical counter', () => {
    const { hlc } = makeClock();
    hlc.now();
    expect(hlc.update(packHlc(T0, 0n))).toEqual({ ok: true, value: packHlc(T0, 1n) });
  });
});
