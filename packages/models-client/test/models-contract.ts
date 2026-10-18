import { describe, expect, test } from 'vitest';
import type { Models } from '@mindlog/models-client';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

/** Behaviour every `Models` implementation must have (CLAUDE.md §3.3). */
export function describeModelsContract(name: string, make: () => Promise<Models>): void {
  describe(`Models contract: ${name}`, () => {
    test('embeddings are one normalised vector per text, similar texts closer', async () => {
      const models = await make();
      const r = await models.embed(
        ['I prefer dark roast coffee', 'dark roast coffee is what I prefer', 'the train was late'],
        'passage',
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.vectors).toHaveLength(3);
      expect(r.value.modelId).not.toBe('');
      for (const v of r.value.vectors) {
        expect(v.length).toBe(r.value.dims);
        expect(cosine(v, v)).toBeCloseTo(1, 4);
      }
      const [a, b, c] = r.value.vectors as [Float32Array, Float32Array, Float32Array];
      expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
    });

    test('no texts gives no vectors', async () => {
      const r = await (await make()).embed([], 'query');
      expect(r.ok && r.value.vectors).toEqual([]);
    });

    test('entities come back per text with character offsets', async () => {
      const text = 'My sister Ana moved to Lisbon';
      const r = await (await make()).recognize([text, 'nothing here'], ['person', 'place']);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.spans).toHaveLength(2);
      const names = (r.value.spans[0] ?? []).map((s) => text.slice(s.start, s.end));
      expect(names.some((n) => n.includes('Ana'))).toBe(true);
      for (const s of r.value.spans[0] ?? []) expect(s.text).toBe(text.slice(s.start, s.end));
    });

    test('NLI labels each pair', async () => {
      const r = await (
        await make()
      ).classify([['I live in Lisbon.', 'I do not live in Lisbon.']] as const);
      expect(r.ok && r.value.results.map((x) => x.label)).toEqual(['contradiction']);
    });

    test('rerank scores each document, in order', async () => {
      const r = await (
        await make()
      ).rerank('what coffee do I like', ['I prefer dark roast coffee', 'the train was late']);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.scores).toHaveLength(2);
      expect(r.value.scores[0]).toBeGreaterThan(r.value.scores[1] ?? 0);
    });

    test('facts are extracted from statements only', async () => {
      const r = await (
        await make()
      ).extractFacts('Hi! I prefer dark roast coffee. What time is it?');
      expect(r.ok && r.value.facts.map((f) => f.text)).toEqual(['I prefer dark roast coffee.']);
    });

    test('health lists the capabilities', async () => {
      const r = await (await make()).health();
      expect(r.ok && r.value.ready).toBe(true);
      if (r.ok)
        expect(Object.keys(r.value.capabilities).sort()).toEqual([
          'embed',
          'extract',
          'ner',
          'nli',
          'rerank',
        ]);
    });
  });
}
