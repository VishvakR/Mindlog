import { describe, expect, test } from 'vitest';
import { ManualClock, SystemClock } from '@mindlog/core';
import { describeClockContract } from './contracts/clock-contract.js';

describeClockContract('SystemClock', () => new SystemClock());
describeClockContract('ManualClock', () => new ManualClock(1_700_000_000_000n));

describe('SystemClock', () => {
  test('tracks the host wall clock', () => {
    const drift = new SystemClock().now() - BigInt(Date.now());
    expect(drift < 0n ? -drift : drift).toBeLessThan(1_000n);
  });
});

describe('ManualClock', () => {
  test('advance moves wall and monotonic time together', () => {
    const clock = new ManualClock(1_000n);
    clock.advance(250n);
    expect(clock.now()).toBe(1_250n);
    expect(clock.monotonic()).toBe(250_000_000n);
  });

  test('setWall can model a backwards jump without touching monotonic time', () => {
    const clock = new ManualClock(5_000n);
    clock.advance(10n);
    clock.setWall(1_000n);
    expect(clock.now()).toBe(1_000n);
    expect(clock.monotonic()).toBe(10_000_000n);
  });

  test('advance rejects negative durations', () => {
    expect(() => {
      new ManualClock().advance(-1n);
    }).toThrow(RangeError);
  });
});
