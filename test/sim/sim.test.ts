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

async function violations(seed: bigint): Promise<string[]> {
  const nodes = seed % 2n === 0n ? 5 : 3;
  const result = await scenario(seed)
    .nodes(nodes)
    .verbose(process.env.SIM_VERBOSE === '1')
    .run();
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

  test('regression seeds', { timeout: 600_000 }, async () => {
    await check(REGRESSION_SEEDS);
  });

  test(ONE ? `seed ${ONE}` : `seeds ${FROM}..${FROM + COUNT - 1n}`, { timeout: 0 }, async () => {
    await check(ONE ? [BigInt(ONE)] : range(FROM, COUNT));
  });
});
