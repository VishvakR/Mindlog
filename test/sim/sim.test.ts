import { describe, expect, test } from 'vitest';
import { scenario } from './cluster.js';
import { REGRESSION_SEEDS } from './regressions.js';

/**
 * Deterministic simulation of whole clusters (PLAN 22.2). `pnpm test` runs a
 * few seeds; `pnpm sim` runs SIM_SEEDS of them (CI 1,000, the phase 3 gate
 * 10,000); `SIM_SEED=n SIM_VERBOSE=1 pnpm sim` replays one seed with a trace.
 */
const ONE = process.env.SIM_SEED;
const FROM = BigInt(process.env.SIM_FROM ?? 1);
const COUNT = BigInt(process.env.SIM_SEEDS ?? 10);

// SIM_PD=1 runs every seed with the placement driver: 5 nodes, 2 of them empty at the start.
const WITH_PD = process.env.SIM_PD === '1';

// SIM_BANK=1 adds the bank-transfer workload (cross-range transactions, ADR-0030) to every seed.
const WITH_BANK = process.env.SIM_BANK === '1';

// SIM_MEM=1 adds the memory workload (remember and forget through the engine, phase 5) to every seed.
const WITH_MEM = process.env.SIM_MEM === '1';

async function violations(seed: bigint): Promise<string[]> {
  const nodes = seed % 2n === 0n ? 5 : 3;
  const sized = WITH_PD ? scenario(seed).nodes(5).pd(2) : scenario(seed).nodes(nodes);
  const banked = WITH_BANK ? sized.bank(8) : sized;
  const base = WITH_MEM ? banked.memory(4) : banked;
  const result = await base.verbose(process.env.SIM_VERBOSE === '1').run();
  return result.violations.map((v) => `replay: SIM_SEED=${seed} SIM_VERBOSE=1 pnpm sim → ${v}`);
}

/** Runs every seed and reports all failures together. */
async function check(seeds: Iterable<bigint>): Promise<void> {
  const failed: string[] = [];
  for (const seed of seeds) failed.push(...(await violations(seed)));
  expect(failed).toEqual([]);
}

function* range(from: bigint, count: bigint): Generator<bigint> {
  for (let seed = from; seed < from + count; seed++) yield seed;
}

describe('simulator', () => {
  test('a seed replays exactly', { timeout: 60_000 }, async () => {
    const [a, b] = [await scenario(42n).nodes(5).run(), await scenario(42n).nodes(5).run()];
    expect(a).toEqual(b);
  });

  test(
    'a node with a skewed clock fences its peers; reads stay linearizable',
    { timeout: 120_000 },
    async () => {
      for (const seed of [1n, 2n, 3n]) {
        const result = await scenario(seed).nodes(3).faults({ skewMs: 8_000 }).run();
        expect(result.violations).toEqual([]);
        expect(result.stats.fencedSteps).toBeGreaterThan(0);
      }
    },
  );

  test(
    'the placement driver fills empty nodes and keeps ranges at full strength under faults',
    { timeout: 300_000 },
    async () => {
      let placed = 0;
      for (const seed of [1n, 2n, 3n, 4n, 5n]) {
        const result = await scenario(seed).nodes(5).pd(2).run();
        expect(result.violations).toEqual([]);
        placed += result.stats.placed;
      }
      expect(placed).toBeGreaterThan(0);
    },
  );

  test(
    'bank transfers across ranges keep the total under splits, partitions and crashes',
    { timeout: 300_000 },
    async () => {
      let committed = 0;
      for (const seed of [1n, 2n, 3n, 4n, 5n]) {
        const result = await scenario(seed).nodes(3).bank(8).run();
        expect(result.violations).toEqual([]);
        committed += result.stats.bank.committed;
      }
      expect(committed).toBeGreaterThan(0);
    },
  );

  test(
    'memory indexes match their records under splits, partitions and crashes',
    { timeout: 300_000 },
    async () => {
      let remembered = 0;
      for (const seed of [1n, 2n, 3n]) {
        const result = await scenario(seed).nodes(3).memory(4).run();
        expect(result.violations).toEqual([]);
        remembered += result.stats.memory.remembered;
      }
      expect(remembered).toBeGreaterThan(0);
    },
  );

  test('regression seeds', { timeout: 600_000 }, async () => {
    await check(REGRESSION_SEEDS);
  });

  test(ONE ? `seed ${ONE}` : `seeds ${FROM}..${FROM + COUNT - 1n}`, { timeout: 0 }, async () => {
    await check(ONE ? [BigInt(ONE)] : range(FROM, COUNT));
  });
});
