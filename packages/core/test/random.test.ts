import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { SeededRandom, SystemRandom } from '@mindlog/core';
import { describeRandomContract } from './contracts/random-contract.js';

describeRandomContract('SystemRandom', () => new SystemRandom());
describeRandomContract('SeededRandom', () => new SeededRandom(42n));

function take(random: SeededRandom, n: number): number[] {
  return Array.from({ length: n }, () => random.nextUint32());
}

describe('SeededRandom', () => {
  test('matches the xoshiro128** reference sequence', () => {
    const random = SeededRandom.fromState([1, 2, 3, 4]);
    expect(take(random, 3)).toEqual([11_520, 0, 5_927_040]);
  });

  test('the same seed yields the same sequence', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(2n ** 70n), max: 2n ** 70n }), (seed) => {
        expect(take(new SeededRandom(seed), 8)).toEqual(take(new SeededRandom(seed), 8));
      }),
    );
  });

  test('reseeding restarts the sequence', () => {
    const random = new SeededRandom(7n);
    const first = take(random, 5);
    random.seed(7n);
    expect(take(random, 5)).toEqual(first);
  });

  test('different seeds diverge', () => {
    expect(take(new SeededRandom(1n), 4)).not.toEqual(take(new SeededRandom(2n), 4));
  });

  test('a zero seed still produces a non-degenerate sequence', () => {
    expect(new Set(take(new SeededRandom(0n), 16)).size).toBeGreaterThan(1);
  });
});
