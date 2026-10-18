import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import { ManualClock, MemoryMetrics, OtelTracer, err, mindlogError, ok } from '@mindlog/core';
import type { Stage } from '@mindlog/memory';
import { finalScore, pack, recency, retention, rrf, runStages } from '@mindlog/memory';
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
  test('takes items in order until the token budget is spent', () => {
    const items = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((text, i) => ({
      id: String(i),
      text,
    }));
    const p = pack(items, 25);
    expect(p.ids).toEqual(['0', '1']);
    expect(p.tokens).toBeLessThanOrEqual(25);
    expect(p.context.split('\n')).toHaveLength(2);
  });

  test('an item larger than the whole budget is skipped, not cut', () => {
    expect(pack([{ id: 'x', text: 'z'.repeat(400) }], 10)).toEqual({
      ids: [],
      context: '',
      tokens: 0,
    });
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
