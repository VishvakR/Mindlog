import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { ManualClock, MemoryMetrics, OtelTracer, err, mindlogError, ok } from '@mindlog/core';
import type { Stage } from '@mindlog/memory';
import type { PackItem } from '@mindlog/memory';
import {
  classifyQuery,
  estimateTokens,
  finalScore,
  mmr,
  pack,
  recency,
  retention,
  rrf,
  runStages,
} from '@mindlog/memory';
import { ctx, memoryNode, scope } from './support/memory-node.js';

interface Draft {
  readonly steps: readonly string[];
}

const run = (stages: Stage<Draft>[], available = () => true) =>
  runStages(
    stages,
    { steps: [] },
    {
      pipeline: 'test',
      clock: new ManualClock(0n),
      metrics: new MemoryMetrics(),
      tracer: new OtelTracer(),
      available,
    },
  );

const step = (name: string, extra: Partial<Stage<Draft>> = {}): Stage<Draft> => ({
  name,
  run: (d) => Promise.resolve(ok({ steps: [...d.steps, name] })),
  ...extra,
});

describe('runStages', () => {
  test('runs stages in order', async () => {
    const r = await run([step('a'), step('b')]);
    expect(r.ok && r.value.draft.steps).toEqual(['a', 'b']);
    expect(r.ok && [...r.value.degraded]).toEqual([]);
  });

  test('a skippable failure uses the fallback and marks the run degraded', async () => {
    const r = await run([
      step('a', {
        run: () =>
          Promise.resolve(err({ kind: 'skippable', error: mindlogError('UNAVAILABLE', 'x') })),
        fallback: (d) => ({ steps: [...d.steps, 'a-fallback'] }),
      }),
      step('b'),
    ]);
    expect(r.ok && r.value.draft.steps).toEqual(['a-fallback', 'b']);
    expect(r.ok && [...r.value.degraded]).toEqual(['a']);
  });

  test('a stage whose model is unavailable is not called', async () => {
    let called = false;
    const r = await run(
      [
        step('embed', {
          needs: 'embed',
          run: (d) => {
            called = true;
            return Promise.resolve(ok(d));
          },
          fallback: (d) => d,
        }),
      ],
      () => false,
    );
    expect(called).toBe(false);
    expect(r.ok && [...r.value.degraded]).toEqual(['embed']);
  });

  test('a fatal failure, or one without a fallback, stops the pipeline', async () => {
    const fatal = await run([
      step('a', {
        run: () =>
          Promise.resolve(err({ kind: 'fatal', error: mindlogError('INVALID_ARGUMENT', 'bad') })),
      }),
      step('b'),
    ]);
    expect(!fatal.ok && fatal.error.code).toBe('INVALID_ARGUMENT');
    const noFallback = await run([
      step('a', {
        run: () =>
          Promise.resolve(err({ kind: 'skippable', error: mindlogError('UNAVAILABLE', 'x') })),
      }),
    ]);
    expect(!noFallback.ok && noFallback.error.code).toBe('UNAVAILABLE');
  });

  test('a stage past its timeout is treated as skippable', async () => {
    const r = await run([
      step('slow', {
        timeoutMs: 10,
        run: () => new Promise(() => undefined),
        fallback: (d) => ({ steps: [...d.steps, 'timed-out'] }),
      }),
    ]);
    expect(r.ok && r.value.draft.steps).toEqual(['timed-out']);
  });
});

describe('scoring', () => {
  test('RRF sums weighted reciprocal ranks (k = 60)', () => {
    const fused = rrf(
      new Map([
        ['vector', ['a', 'b']],
        ['keyword', ['b', 'c']],
      ]),
      { vector: 1, keyword: 2 },
    );
    expect(fused.get('a')).toBeCloseTo(1 / 61, 10);
    expect(fused.get('b')).toBeCloseTo(1 / 62 + 2 / 61, 10);
    expect(fused.get('c')).toBeCloseTo(2 / 62, 10);
  });

  test('RRF never ranks a document lower for appearing in one more list (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 4 }), (extra) => {
        const base = rrf(new Map([['vector', ['a', 'b', 'c']]]), {});
        const more = rrf(
          new Map([
            ['vector', ['a', 'b', 'c']],
            ['keyword', [...new Set(extra)]],
          ]),
          {},
        );
        for (const [id, s] of base) expect(more.get(id) ?? 0).toBeGreaterThanOrEqual(s);
      }),
    );
  });

  test('recency, retention and the final score follow PLAN 12.5', () => {
    expect(recency(0)).toBe(1);
    expect(recency(10)).toBeCloseTo(0.995 ** 10, 12);
    expect(retention(0, 2)).toBe(1);
    expect(retention(2, 2)).toBeCloseTo(Math.exp(-1), 12);
    expect(
      finalScore({ relevance: 1, recency: 1, importance: 1, retention: 1, trust: 'normal' }),
    ).toBeCloseTo(1, 12);
    expect(
      finalScore({ relevance: 1, recency: 1, importance: 1, retention: 1, trust: 'verified' }),
    ).toBeCloseTo(1.05, 12);
  });
});

describe('pack', () => {
  const item = (id: string, text: string, score = 1, kind = 'semantic'): PackItem => ({
    id,
    text,
    kind,
    score,
  });

  test('takes the most valuable items per token, groups them and stays within the budget', () => {
    const items = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((t, i) =>
      item(String(i), t, 1 - i / 10),
    );
    const p = pack(items, 30);
    expect(p.ids).toEqual(['0', '1']);
    expect(p.dropped).toEqual(['2']);
    expect(p.tokens).toBeLessThanOrEqual(30);
    expect(p.context.split('\n')).toEqual([
      '## Facts',
      `- ${'a'.repeat(40)}`,
      `- ${'b'.repeat(40)}`,
    ]);
    expect(p.groups).toEqual([{ name: 'Facts', ids: ['0', '1'] }]);
  });

  test('groups by kind in a fixed order', () => {
    const p = pack(
      [
        item('e', 'went hiking', 0.9, 'episodic'),
        item('f', 'likes tea', 0.5),
        item('p', 'run tests first', 0.4, 'procedural'),
      ],
      100,
    );
    expect(p.groups.map((g) => g.name)).toEqual(['Facts', 'Procedures', 'Recent episodes']);
    expect(p.context).toBe(
      '## Facts\n- likes tea\n\n## Procedures\n- run tests first\n\n## Recent episodes\n- went hiking',
    );
  });

  test('a long item that no longer fits is shortened to its leading sentences', () => {
    const long = 'First point. Second point is longer. ' + 'Filler sentence here. '.repeat(20);
    const p = pack([item('x', long)], 15);
    expect(p.compressed).toEqual(['x']);
    expect(p.context).toContain('- First point.');
    expect(p.context).toContain('…');
    expect(p.tokens).toBeLessThanOrEqual(15);
  });

  test('an item whose first sentence is over the budget is dropped, not cut', () => {
    const p = pack([item('x', 'z'.repeat(400))], 10);
    expect(p).toMatchObject({ ids: [], context: '', tokens: 0, dropped: ['x'] });
  });

  test('the swap pass replaces a cheap low-value item with a valuable one', () => {
    // Greedy by density takes the tiny item first; the valuable one then fits only by swapping.
    const p = pack([item('cheap', 'ok', 0.2), item('big', 'w'.repeat(60), 1)], 19);
    expect(p.ids).toEqual(['big']);
  });

  test('never exceeds the budget and is deterministic', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            text: fc.string({ minLength: 1, maxLength: 300 }),
            score: fc.double({ min: 0, max: 1, noNaN: true }),
            kind: fc.constantFrom('semantic', 'episodic', 'procedural', 'theme'),
          }),
          { maxLength: 30 },
        ),
        fc.integer({ min: 1, max: 400 }),
        (raw, budget) => {
          const items = raw.map((r, i) => item(String(i), r.text, r.score, r.kind));
          const p = pack(items, budget);
          expect(p.tokens).toBeLessThanOrEqual(budget);
          expect(estimateTokens(p.context)).toBe(p.tokens);
          expect(pack(items, budget)).toEqual(p);
          expect(new Set([...p.ids, ...p.dropped]).size).toBe(items.length);
        },
      ),
    );
  });
});

describe('routing and diversity', () => {
  test('two entities are multi-hop, broad cues without entities are broad', () => {
    expect(classifyQuery('how is Ana related to Acme', 2)).toBe('multihop');
    expect(classifyQuery('summarize what you know about my habits', 0)).toBe('broad');
    expect(classifyQuery('what coffee do I like', 0)).toBe('specific');
    expect(classifyQuery('summarize Ana', 1)).toBe('specific');
  });

  test('mmr keeps the best first and pushes a near-duplicate down', () => {
    const c = [
      { id: 'a', text: 'dark roast coffee every morning', score: 1 },
      { id: 'b', text: 'dark roast coffee every morning please', score: 0.95 },
      { id: 'c', text: 'flies to lisbon in may', score: 0.8 },
    ];
    const sim = (x: { text: string }, y: { text: string }) => {
      const a = new Set(x.text.split(' '));
      const b = new Set(y.text.split(' '));
      const shared = [...a].filter((w) => b.has(w)).length;
      return shared / (a.size + b.size - shared);
    };
    expect(mmr(c, sim).map((x) => x.id)).toEqual(['a', 'c', 'b']);
    expect(mmr(c, sim, 1).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('VectorCache', () => {
  test('follows commits after apply without rebuilding, and rebuilds when the generation is unknown', async () => {
    const n = await memoryNode();
    await n.engine.remember(
      n.range,
      { scope: scope(), content: 'first fact here', kind: 'semantic' },
      ctx,
    );
    await n.engine.recall(n.range, { scope: scope(), query: 'fact' }, ctx);
    const rebuilds = () => n.metrics.value('mindlog_memory_vector_rebuilds_total');
    const before = rebuilds();
    await n.engine.remember(
      n.range,
      { scope: scope(), content: 'second fact here', kind: 'semantic' },
      ctx,
    );
    const r = await n.engine.recall(n.range, { scope: scope(), query: 'second fact' }, ctx);
    expect(r.ok && r.value.items[0]?.memory.text).toBe('second fact here');
    expect(rebuilds()).toBe(before);
    n.vectors.clear();
    await n.engine.recall(n.range, { scope: scope(), query: 'second fact' }, ctx);
    expect(rebuilds()).toBe(before + 1);
  });
});
