import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import type { SimilarityEvaluator } from '@mindlog/cache';
import { SemanticCache, cosineEvaluator, normalizePrompt, similarityOf } from '@mindlog/cache';
import { CacheEntrySchema } from '@mindlog/proto';
import { call, cacheNode, scope } from './support/cache-node.js';

type Node = Awaited<ReturnType<typeof cacheNode>>;

async function store(n: Node, prompt: string, answer: string, extra: object = {}) {
  const r = await n.cache.store(n.range, scope, { prompt, answer, ...extra }, call);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.id;
}

async function lookup(n: Node, prompt: string, threshold?: number) {
  const r = await n.cache.lookup(n.range, scope, prompt, threshold);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('SemanticCache', () => {
  test('the same prompt hits L1, a reworded one hits L2, an unrelated one misses', async () => {
    const n = await cacheNode();
    const id = await store(n, 'What coffee does Ana like?', 'Dark roast.');
    expect((await lookup(n, '  what COFFEE does ana like? ')).hit).toMatchObject({
      id,
      answer: 'Dark roast.',
      level: 'l1',
      similarity: 1,
    });
    // FakeModels embeds bags of words: the same words in another order are cosine 1.
    expect((await lookup(n, 'does Ana like what coffee?')).hit).toMatchObject({ id, level: 'l2' });
    expect((await lookup(n, 'when is the dentist appointment')).hit).toBeUndefined();
    expect(n.metrics.value('mindlog_cache_lookups_total', { result: 'hit_l1' })).toBe(1);
    expect(n.metrics.value('mindlog_cache_lookups_total', { result: 'miss' })).toBe(1);
    expect(n.metrics.value('mindlog_cache_tokens_saved_total')).toBeGreaterThan(0);
  });

  test('the threshold decides near misses', async () => {
    const n = await cacheNode();
    await store(n, 'what coffee does ana like', 'Dark roast.');
    const near = 'what coffee does ana like now';
    const strict = await lookup(n, near, 0.99);
    expect(strict.hit).toBeUndefined();
    const loose = await lookup(n, near, 0.8);
    expect(loose.hit?.similarity).toBeGreaterThan(0.8);
    expect(loose.hit?.similarity).toBeLessThan(0.99);
  });

  test('an entry past its TTL is a miss', async () => {
    const n = await cacheNode();
    await store(n, 'weather today', 'Sunny.', { ttlSeconds: 60 });
    expect((await lookup(n, 'weather today')).hit).toBeDefined();
    n.clock.advance(61_000n);
    expect((await lookup(n, 'weather today')).hit).toBeUndefined();
  });

  test('without an embedder entries are stored and found by exact prompt only', async () => {
    const n = await cacheNode();
    n.models.down = true;
    const stored = await n.cache.store(
      n.range,
      scope,
      { prompt: 'Ana coffee', answer: 'Dark.' },
      call,
    );
    expect(stored.ok && stored.value.degraded).toBe(true);
    const fresh = new SemanticCache({
      models: n.models,
      stamper: n.stamper,
      ids: { next: () => 'unused' },
      clock: n.clock,
      metrics: n.metrics,
      tracer: { withSpan: (_name, _attrs, fn) => fn({} as never) },
    });
    const exact = await fresh.lookup(n.range, scope, 'ana coffee');
    expect(exact.ok && exact.value).toMatchObject({ hit: { level: 'l2' }, degraded: true });
    const other = await fresh.lookup(n.range, scope, 'coffee ana');
    expect(other.ok && other.value.hit).toBeUndefined();
  });

  test('a scope holds at most maxEntries; the oldest go first', async () => {
    const n = await cacheNode({ maxEntries: 2 });
    const first = await store(n, 'first question here', 'one');
    n.clock.advance(1n);
    await store(n, 'second question here', 'two');
    n.clock.advance(1n);
    await store(n, 'third question here', 'three');
    expect((await lookup(n, 'first question here')).hit).toBeUndefined();
    expect((await lookup(n, 'third question here')).hit?.answer).toBe('three');
    const again = await n.cache.invalidate(n.range, scope, [first], call);
    expect(again.ok && again.value.count).toBe(0);
  });

  test('invalidate drops entries by id, and the L1 map does not resurrect them', async () => {
    const n = await cacheNode();
    const id = await store(n, 'what tea do i like', 'Green tea.');
    const done = await n.cache.invalidate(n.range, scope, [id, 'missing'], call);
    expect(done.ok && done.value.count).toBe(1);
    expect((await lookup(n, 'what tea do i like')).hit).toBeUndefined();
  });

  test('scopes are separate', async () => {
    const n = await cacheNode();
    await store(n, 'what tea do i like', 'Green tea.');
    const other = await n.cache.lookup(n.range, { ...scope, user: 'u2' }, 'what tea do i like');
    expect(other.ok && other.value.hit).toBeUndefined();
  });

  test('a custom evaluator can veto a cosine candidate', async () => {
    const n = await cacheNode();
    await store(n, 'what coffee does ana like', 'Dark roast.');
    const strict: SimilarityEvaluator = { name: 'never', evaluate: () => Promise.resolve(0) };
    const vetoing = new SemanticCache({
      models: n.models,
      stamper: n.stamper,
      ids: { next: () => 'x' },
      clock: n.clock,
      metrics: n.metrics,
      tracer: { withSpan: (_name, _attrs, fn) => fn({} as never) },
      evaluator: strict,
    });
    const r = await vetoing.lookup(n.range, scope, 'does ana like what coffee');
    expect(r.ok && r.value.hit).toBeUndefined();
  });
});

describe('similarity evaluators (contract)', () => {
  const entry = (prompt: string, vector?: number[]) =>
    create(CacheEntrySchema, {
      id: 'e',
      prompt,
      answer: 'a',
      vector: vector ? new Uint8Array(Float32Array.from(vector).buffer) : new Uint8Array(),
    });
  for (const evaluator of [cosineEvaluator]) {
    test(`${evaluator.name}: exact prompts score 1, scores stay within 0..1 for unit vectors`, async () => {
      expect(await evaluator.evaluate({ prompt: 'p' }, entry('p'))).toBe(1);
      const s = await evaluator.evaluate(
        { prompt: 'q', vector: Float32Array.from([0.6, 0.8]) },
        entry('p', [1, 0]),
      );
      expect(s).toBeCloseTo(0.6, 6);
      expect(await evaluator.evaluate({ prompt: 'q' }, entry('p', [1, 0]))).toBe(0);
    });
  }

  test('normalisation folds width, case and spacing', () => {
    expect(normalizePrompt('  ＡＢＣ   Def\n')).toBe('abc def');
    expect(similarityOf({ prompt: 'x', vector: Float32Array.from([1]) }, entry('y', [1, 0]))).toBe(
      0,
    );
  });
});

describe('retries', () => {
  test('a store retried with the same request id reports the id that was stored', async () => {
    const n = await cacheNode();
    const requestId = new TextEncoder().encode('retry-1');
    const first = await n.cache.store(
      n.range,
      scope,
      { prompt: 'p one', answer: 'a' },
      { ...call, requestId },
    );
    const again = await n.cache.store(
      n.range,
      scope,
      { prompt: 'p one', answer: 'a' },
      { ...call, requestId },
    );
    expect(first.ok && again.ok && again.value.id).toBe(first.ok && first.value.id);
  });
});
