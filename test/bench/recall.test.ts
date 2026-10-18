import { Redis } from 'ioredis';
import { afterAll, describe, expect, test } from 'vitest';
import type { ServedModels } from '@mindlog/models-client';
import { FakeModels, serveModels } from '@mindlog/models-client';
import { startTestNode } from '../support/node.js';

/**
 * Phase 5 gate (PLAN 24): recall p95 < 150 ms with 10K memories in a scope.
 * Opt-in: `BENCH=1 pnpm vitest run test/bench/recall.test.ts` (scripts/bench-recall.sh).
 * Models: FakeModels over gRPC by default; BENCH_MODELS=host:port uses a running
 * model service (real embeddings and NER; seeding is then much slower).
 */
const MEMORIES = Number(process.env.BENCH_MEMORIES ?? 10_000);
const QUERIES = Number(process.env.BENCH_QUERIES ?? 300);
const CONCURRENCY = 32;

const WORDS = (
  'coffee tea lisbon porto deploy release budget garden python rust train flight hotel ' +
  'meeting project report invoice recipe dinner music guitar running swimming doctor dentist ' +
  'birthday anniversary sister brother manager client server database cache window aisle'
).split(' ');
const NAMES = ['Ana', 'Bob', 'Chen', 'Dara', 'Eli', 'Farah', 'Goran', 'Hana'];

/** A deterministic synthetic memory: a few topic words and a name. */
function memoryText(i: number): string {
  const w = (k: number) => WORDS[(i * 7 + k * 13) % WORDS.length] ?? 'note';
  const name = NAMES[i % NAMES.length] ?? 'Ana';
  return `Note ${String(i)}: ${name} mentioned the ${w(1)} and the ${w(2)} near the ${w(3)}.`;
}

const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;

let models: ServedModels | undefined;
let server: Awaited<ReturnType<typeof startTestNode>> | undefined;
let redis: Redis | undefined;

afterAll(async () => {
  redis?.disconnect();
  await server?.stop();
  await models?.close();
});

describe.skipIf(process.env.BENCH !== '1')('recall benchmark', () => {
  test(
    `p95 recall under 150 ms at ${String(MEMORIES)} memories`,
    { timeout: 1_800_000 },
    async () => {
      if (!process.env.BENCH_MODELS) models = await serveModels(new FakeModels());
      const endpoint = process.env.BENCH_MODELS ?? models?.address ?? '';
      server = await startTestNode({ models: { endpoint, timeoutMs: 10_000 } });
      redis = new Redis({ port: server.port, host: '127.0.0.1', maxRetriesPerRequest: 0 });

      const seedStart = performance.now();
      let next = 0;
      await Promise.all(
        Array.from({ length: CONCURRENCY }, async () => {
          for (let i = next++; i < MEMORIES; i = next++)
            await redis?.call('MEM.ADD', 'bench', memoryText(i), 'KIND', 'semantic');
        }),
      );
      const seedMs = performance.now() - seedStart;

      const times: number[] = [];
      for (let q = 0; q < QUERIES + 20; q++) {
        const query = `${WORDS[q % WORDS.length] ?? ''} ${NAMES[q % NAMES.length] ?? ''}`;
        const started = performance.now();
        const items = (await redis.call('MEM.SEARCH', 'bench', query, 'K', '10')) as unknown[];
        if (q >= 20) times.push(performance.now() - started); // the first 20 warm the caches
        expect(items.length).toBeGreaterThan(0);
      }
      times.sort((a, b) => a - b);
      const report = {
        memories: MEMORIES,
        queries: QUERIES,
        models: process.env.BENCH_MODELS ? `service at ${endpoint}` : 'FakeModels over gRPC',
        seedSeconds: Math.round(seedMs / 100) / 10,
        p50Ms: Math.round(percentile(times, 50) * 10) / 10,
        p95Ms: Math.round(percentile(times, 95) * 10) / 10,
        p99Ms: Math.round(percentile(times, 99) * 10) / 10,
      };
      console.log(`recall benchmark ${JSON.stringify(report)}`);
      expect(report.p95Ms).toBeLessThan(150);
    },
  );
});
