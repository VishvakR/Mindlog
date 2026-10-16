import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { quorumSize, quorumValue, voteResult } from '../src/quorum/majority.js';
import { Inflights } from '../src/tracker/inflights.js';

const ids = fc.uniqueArray(fc.bigInt({ min: 1n, max: 50n }), { minLength: 1, maxLength: 7 });

describe('quorum math', () => {
  test('quorumValue is reached by a majority and exceeded by none smaller', () => {
    fc.assert(
      fc.property(
        ids,
        fc.array(fc.bigInt({ min: 0n, max: 100n }), { minLength: 7, maxLength: 7 }),
        (voters, values) => {
          const set = new Set(voters);
          const valueOf = (id: bigint): bigint => values[Number(id) % 7] ?? 0n;
          const q = quorumValue(set, valueOf);
          const atLeast = voters.filter((id) => valueOf(id) >= q).length;
          expect(atLeast).toBeGreaterThanOrEqual(quorumSize(set.size));
          const above = voters.filter((id) => valueOf(id) > q).length;
          expect(above).toBeLessThan(quorumSize(set.size));
        },
      ),
    );
  });

  test('voteResult: won and lost are mutually exclusive and final', () => {
    fc.assert(
      fc.property(
        ids,
        fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
        (voters, answers) => {
          const set = new Set(voters);
          const votes = new Map<bigint, boolean>();
          let decided: string | undefined;
          voters.forEach((id, i) => {
            votes.set(id, answers[i] ?? false);
            const result = voteResult(set, votes);
            if (decided) expect(result).toBe(decided);
            else if (result !== 'pending') decided = result;
          });
          const granted = voters.filter((_, i) => answers[i]).length;
          expect(voteResult(set, votes)).toBe(granted >= quorumSize(set.size) ? 'won' : 'lost');
        },
      ),
    );
  });
});

describe('Inflights', () => {
  test('tracks count and bytes, frees by index, and reports full at the limits', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100 }), { maxLength: 40 }),
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 0, max: 40 }),
        (sizes, maxCount, freeTo) => {
          const inflights = new Inflights(maxCount, 300);
          let index = 0n;
          const added: Array<[bigint, number]> = [];
          for (const size of sizes) {
            if (inflights.full()) break;
            index += 1n;
            inflights.add(index, size);
            added.push([index, size]);
          }
          expect(inflights.count).toBeLessThanOrEqual(maxCount);
          inflights.freeLE(BigInt(freeTo));
          const left = added.filter(([i]) => i > BigInt(freeTo));
          expect(inflights.count).toBe(left.length);
          expect(inflights.bytes).toBe(left.reduce((n, [, s]) => n + s, 0));
        },
      ),
    );
  });

  test('rejects non-increasing indexes', () => {
    const inflights = new Inflights(4, 0);
    inflights.add(2n, 1);
    expect(() => {
      inflights.add(2n, 1);
    }).toThrow();
  });
});
