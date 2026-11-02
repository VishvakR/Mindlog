import { writeFileSync } from 'node:fs';
import { create } from '@bufbuild/protobuf';
import { afterAll, describe, expect, test } from 'vitest';
import { ManualClock, MemoryMetrics } from '@mindlog/core';
import { MemoryReads, encodeSegment, stubText } from '@mindlog/memory';
import type { Models } from '@mindlog/models-client';
import { FakeModels, GrpcModels, GuardedModels } from '@mindlog/models-client';
import { TierMoveSchema } from '@mindlog/proto';
import { DAY, lifecycleNode, scope } from '../support/lifecycle-node.js';

/**
 * Phase 8 gate (PLAN 24): over 30 simulated days, the forgetting curve keeps
 * old-but-important facts recallable better than LRU eviction with the same
 * number of hot memories, and the hot count stays bounded.
 * Opt-in: `BENCH=1 pnpm vitest run test/bench/lifecycle.test.ts` (scripts/lifecycle-eval.sh).
 * Models: FakeModels by default; BENCH_MODELS=host:port uses the model service.
 */
const DAYS = Number(process.env.EVAL_DAYS ?? 30);
const IMPORTANT = Number(process.env.EVAL_IMPORTANT ?? 40);
const NOISE_PER_DAY = Number(process.env.EVAL_NOISE ?? 10);
const RECALL_DAYS = new Set([3, 8, 15]);
const K = 5;
const OUT = process.env.EVAL_OUT;
// No rerank by default: FakeModels' word-overlap reranker favours long summaries that repeat "I".
const RECIPE = (process.env.EVAL_RECIPE ?? 'hybrid') as 'hybrid';

const PREFS = (
  'aisle seats|oat milk|dark roast|window tables|green tea|early flights|quiet hotels|' +
  'paper books|night trains|spicy food|cold showers|morning runs|jazz records|wool socks|' +
  'blue pens|small teams|written specs|tabs over spaces|vim keys|sourdough bread'
).split('|');
const TOPICS = (
  'flights|coffee|breakfast|restaurants|drinks|travel|holidays|reading|trips|dinner|' +
  'mornings|exercise|music|winter|notes|work|planning|code|editors|baking'
).split('|');
const NOISE = (
  'saw a pigeon|heard thunder|passed a bakery|watched clouds|found a coin|missed a bus|' +
  'met a neighbour|smelled rain|read a sign|crossed a bridge|fed a cat|lost a glove'
).split('|');
const PLACES = 'station|market|park|harbour|plaza|library|garden|tower|lane|square'.split('|');

// Fact i pairs a preference with a topic; past 20 facts the topics shift, so no two facts are near-duplicates.
const topic = (i: number) => TOPICS[(i + 7 * Math.floor(i / PREFS.length)) % TOPICS.length] ?? '';
const fact = (i: number) =>
  `I always prefer ${PREFS[i % PREFS.length] ?? ''} for ${topic(i)} number ${String(i)}.`;
const query = (i: number) => `what do I prefer for ${topic(i)} number ${String(i)}`;
/** Facts are semantic memories; themes and summaries that quote them are not the fact. */
const FACT_KINDS = ['semantic', 'procedural'] as const;
const noise = (d: number, j: number) =>
  `Today I ${NOISE[(d * 7 + j) % NOISE.length] ?? ''} near the ${PLACES[(d + j * 3) % PLACES.length] ?? ''} on day ${String(d)}.`;

function realModels(): Models {
  const address = process.env.BENCH_MODELS ?? '';
  return new GuardedModels(new GrpcModels({ address, timeoutMs: 20_000 }), {
    clock: new ManualClock(0n),
    metrics: new MemoryMetrics(),
    failures: 5,
    openMs: 10_000,
  });
}

type Node = Awaited<ReturnType<typeof lifecycleNode>>;

/** LRU eviction: keeps the `cap` most recently used memories hot, moves the rest cold. */
async function evictLru(n: Node, cap: number, day: number): Promise<void> {
  const reads = new MemoryReads(n.range.reader, 'acme', 'u1');
  const hot = [];
  for await (const r of reads.records()) if (r.expiredAt === 0n && r.tier !== 'cold') hot.push(r);
  hot.sort((a, b) => Number((b.lastRecalledAt || b.createdAt) - (a.lastRecalledAt || a.createdAt)));
  const out = hot.slice(cap);
  if (out.length === 0 || !n.blob) return;
  const entries = [];
  for (const record of out) {
    const v = await reads.vector(record.id);
    entries.push({ record, vector: v?.vector ?? new Uint8Array(), modelId: v?.modelId ?? '' });
  }
  const seg = encodeSegment('acme', 'u1', entries);
  await n.blob.put(seg.key, seg.bytes);
  const done = await n.engine.maintain(
    n.range,
    scope(),
    {
      tier: out.map((r) =>
        create(TierMoveSchema, {
          id: r.id,
          tier: 'cold',
          segment: seg.key,
          sha256: seg.sha256,
          text: stubText(r.text),
        }),
      ),
    },
    { principal: 'lru', requestId: new TextEncoder().encode(`lru-${String(day)}`) },
  );
  if (!done.ok) throw new Error(done.error.message);
}

interface Run {
  readonly name: string;
  readonly hotByDay: number[];
  readonly totalByDay: number[];
  readonly hits: number;
  readonly hitsWithCold: number;
}

/** One 30-day run: `forgetting` lets the workers run; otherwise LRU evicts to `caps[day]`. */
async function run(name: string, caps?: number[]): Promise<Run> {
  const models = process.env.BENCH_MODELS ? realModels() : new FakeModels();
  const n = await lifecycleNode({
    models,
    // The LRU baseline runs no consolidation, so only eviction changes tiers.
    ...(caps ? { memory: { tickDelayMs: 0 } } : {}),
  });
  const important: string[] = [];
  for (let i = 0; i < IMPORTANT; i++) {
    const r = await n.remember(fact(i), { kind: 'semantic' });
    important.push(r.ids[0] ?? '');
  }
  const hotByDay: number[] = [];
  const totalByDay: number[] = [];
  for (let day = 1; day <= DAYS; day++) {
    n.clock.advance(DAY);
    for (let j = 0; j < NOISE_PER_DAY; j++)
      await n.remember(noise(day, j), {
        kind: 'episodic',
        scope: scope('u1', { session: `d${String(day)}` }),
      });
    if (RECALL_DAYS.has(day)) {
      for (let i = 0; i < IMPORTANT; i++)
        await n.engine.recall(
          n.range,
          { scope: scope(), query: query(i), k: K, kinds: [...FACT_KINDS], recipe: RECIPE },
          { principal: 'eval' },
        );
      await n.engine.flushRecallStats();
    }
    n.clock.advance(20n * 60_000n);
    if (caps) await evictLru(n, caps[day - 1] ?? 0, day);
    else await n.drain(200);
    const s = await n.engine.lifecycle(n.range, scope());
    hotByDay.push(s.hot);
    totalByDay.push(s.hot + s.cold);
  }
  let hits = 0;
  let hitsWithCold = 0;
  for (let i = 0; i < IMPORTANT; i++) {
    const want = important[i] ?? '';
    const found = await n.engine.recall(
      n.range,
      { scope: scope(), query: query(i), k: K, kinds: [...FACT_KINDS], recipe: RECIPE },
      { principal: 'eval' },
    );
    if (found.ok && found.value.items.some((x) => x.memory.id === want)) hits++;
    const cold = await n.engine.recall(
      n.range,
      {
        scope: scope(),
        query: query(i),
        k: K,
        kinds: [...FACT_KINDS],
        recipe: RECIPE,
        includeCold: true,
        asOf: { timeMs: Number(n.clock.now()) },
      },
      { principal: 'eval' },
    );
    if (cold.ok && cold.value.items.some((x) => x.memory.id === want)) hitsWithCold++;
  }
  await n.engine.close();
  return { name, hotByDay, totalByDay, hits, hitsWithCold };
}

const results: Run[] = [];
afterAll(() => {
  if (OUT && results.length === 2)
    writeFileSync(
      OUT,
      JSON.stringify(
        {
          days: DAYS,
          important: IMPORTANT,
          noisePerDay: NOISE_PER_DAY,
          recallDays: [...RECALL_DAYS],
          k: K,
          recipe: RECIPE,
          models: process.env.BENCH_MODELS ? 'model service' : 'FakeModels',
          runs: results,
        },
        null,
        2,
      ),
    );
});

describe.skipIf(process.env.BENCH !== '1')('lifecycle eval', () => {
  test(`forgetting vs LRU over ${String(DAYS)} days`, { timeout: 3_600_000 }, async () => {
    const forgetting = await run('forgetting curve');
    results.push(forgetting);
    const lru = await run('LRU eviction', forgetting.hotByDay);
    results.push(lru);
    for (const r of results)
      process.stdout.write(
        `lifecycle eval: ${r.name}: ${String(r.hits)}/${String(IMPORTANT)} important facts recalled hot, ` +
          `${String(r.hitsWithCold)}/${String(IMPORTANT)} with INCLUDE_COLD; hot ${String(r.hotByDay.at(-1))}, ` +
          `max hot ${String(Math.max(...r.hotByDay))}, total ${String(r.totalByDay.at(-1))}\n`,
      );
    expect(forgetting.hits).toBeGreaterThan(lru.hits);
    // Bounded: the last week's hot count stays under the first fortnight's peak plus a margin.
    const peak = Math.max(...forgetting.hotByDay.slice(0, 15));
    expect(Math.max(...forgetting.hotByDay.slice(-7))).toBeLessThanOrEqual(peak * 1.25);
  });
});
