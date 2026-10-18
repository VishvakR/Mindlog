import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import type { PostingReader } from '@mindlog/index-text';
import {
  bm25Score,
  decodeCount,
  decodePosting,
  decodeStats,
  encodeCount,
  encodePosting,
  encodeStats,
  searchBm25,
  stem,
  termCounts,
  tokenize,
} from '@mindlog/index-text';

describe('tokenize', () => {
  test('lowercases, drops stop words and punctuation, stems', () => {
    expect(tokenize('I prefer the Dark-Roast coffees, not teas!')).toEqual([
      'prefer',
      'dark',
      'roast',
      'coffe',
      'tea',
    ]);
  });

  test('handles non-Latin scripts as words', () => {
    expect(tokenize('Café über 東京')).toEqual(['café', 'über', '東京']);
  });

  test('counts terms and the document length', () => {
    expect(termCounts('roast roast coffee')).toEqual({
      terms: new Map([
        ['roast', 2],
        ['coffe', 1],
      ]),
      length: 3,
    });
  });
});

describe('Porter stemmer', () => {
  test.each([
    ['caresses', 'caress'],
    ['ponies', 'poni'],
    ['running', 'run'],
    ['agreed', 'agre'],
    ['happiness', 'happi'],
    ['relational', 'relat'],
    ['generalization', 'gener'],
    ['electricity', 'electr'],
    ['adjustment', 'adjust'],
    ['sky', 'sky'],
    ['meetings', 'meet'],
  ])('%s → %s', (word, expected) => {
    expect(stem(word)).toBe(expected);
  });
});

describe('BM25', () => {
  test('follows PLAN 11.2 (k1 = 1.2, b = 0.75)', () => {
    // N = 10 docs, avgdl = 5, df = 2, tf = 3, |d| = 4
    const idf = Math.log((10 - 2 + 0.5) / (2 + 0.5) + 1);
    const expected = (idf * (3 * 2.2)) / (3 + 1.2 * (1 - 0.75 + (0.75 * 4) / 5));
    expect(bm25Score(3, 4, 2, { docs: 10, totalLength: 50 })).toBeCloseTo(expected, 10);
  });

  test('more occurrences never score lower (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1, max: 100 }),
        (tf, len, docs) => {
          const stats = { docs, totalLength: docs * 20 };
          const df = Math.max(1, Math.floor(docs / 3));
          expect(bm25Score(tf + 1, len, df, stats)).toBeGreaterThanOrEqual(
            bm25Score(tf, len, df, stats),
          );
        },
      ),
    );
  });

  test('codecs round-trip', () => {
    expect(decodePosting(encodePosting({ tf: 7, length: 300 }))).toEqual({ tf: 7, length: 300 });
    expect(decodeCount(encodeCount(42))).toBe(42);
    expect(decodeCount(undefined)).toBe(0);
    expect(decodeStats(encodeStats({ docs: 3, totalLength: 99 }))).toEqual({
      docs: 3,
      totalLength: 99,
    });
    expect(decodeStats(undefined)).toEqual({ docs: 0, totalLength: 0 });
  });
});

describe('searchBm25', () => {
  const docs: Record<string, string> = {
    m1: 'I prefer dark roast coffee',
    m2: 'The train to Lisbon was late',
    m3: 'Coffee with milk in the morning, coffee again at noon',
  };
  const index = new Map<string, Map<string, { tf: number; length: number }>>();
  for (const [id, text] of Object.entries(docs)) {
    const { terms, length } = termCounts(text);
    for (const [term, tf] of terms) {
      const postings = index.get(term) ?? new Map<string, { tf: number; length: number }>();
      postings.set(id, { tf, length });
      index.set(term, postings);
    }
  }
  const reader: PostingReader = {
    stats: () =>
      Promise.resolve({
        docs: 3,
        totalLength: Object.values(docs).reduce((n, t) => n + termCounts(t).length, 0),
      }),
    df: (term) => Promise.resolve(index.get(term)?.size ?? 0),
    async *postings(term) {
      await Promise.resolve(); // a store read
      for (const [id, p] of index.get(term) ?? []) yield { id, ...p };
    },
  };

  test('ranks by BM25 and keeps the top k', async () => {
    const hits = await searchBm25(reader, tokenize('coffee roast'), 2);
    expect(hits.map((h) => h.id)).toEqual(['m1', 'm3']);
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  test('no matching term and an empty index give nothing', async () => {
    expect(await searchBm25(reader, tokenize('bicycle'), 5)).toEqual([]);
    expect(
      await searchBm25(
        { ...reader, stats: () => Promise.resolve({ docs: 0, totalLength: 0 }) },
        ['coffe'],
        5,
      ),
    ).toEqual([]);
  });
});
