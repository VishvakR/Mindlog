import fc from 'fast-check';
import { expect, test } from 'vitest';
import { tenantBudgets } from '../src/tenant-budgets.js';

const stat = (tenant: string, writeQps: number, bytes = 0n) => ({
  tenant,
  writeQps,
  recallQps: 0,
  bytes,
  keys: 0n,
  memories: 0n,
});

test('usage is summed and shares follow demand, with a floor', () => {
  const b = tenantBudgets(
    new Map([
      [1n, [stat('t', 90, 10n)]],
      [2n, [stat('t', 10, 5n)]],
    ]),
  );
  const one = b.get(1n)?.[0];
  const two = b.get(2n)?.[0];
  expect(one?.bytes).toBe(15n);
  expect(one?.share).toBeCloseTo(0.05 + 0.9 * 0.9);
  expect(two?.share).toBeCloseTo(0.05 + 0.9 * 0.1);
});

test('no demand splits evenly, and an idle store keeps a share', () => {
  const idle = tenantBudgets(
    new Map([
      [1n, [stat('t', 0)]],
      [2n, []],
    ]),
  );
  expect(idle.get(2n)?.[0]?.share).toBeCloseTo(0.5);
  const busy = tenantBudgets(
    new Map([
      [1n, [stat('t', 5)]],
      [2n, []],
    ]),
  );
  expect(busy.get(2n)?.[0]?.share).toBeCloseTo(0.05);
});

test('a tenant’s shares always sum to one', () => {
  fc.assert(
    fc.property(
      fc.array(fc.double({ min: 0, max: 1e6, noNaN: true }), { minLength: 1, maxLength: 12 }),
      (demand) => {
        const stores = new Map(demand.map((d, i) => [BigInt(i + 1), [stat('t', d)]] as const));
        const sum = [...tenantBudgets(stores).values()].flat().reduce((acc, x) => acc + x.share, 0);
        expect(sum).toBeCloseTo(1, 6);
      },
    ),
  );
});
