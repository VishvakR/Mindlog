import { stem } from './porter.js';

// A short English list; tenants with other languages get their own in a later phase.
const STOP_WORDS = new Set(
  (
    'a an and are as at be been but by do does for from had has have he her his i if in into is ' +
    'it its me my no not of on or our she so that the their them then there these they this to ' +
    'was we were what when where which who will with you your'
  ).split(' '),
);

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Search terms of a text (PLAN 11.2): Unicode words, lowercased, stop words dropped, stemmed. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text)) {
    if (!s.isWordLike) continue;
    const word = s.segment.toLowerCase();
    if (!STOP_WORDS.has(word)) out.push(stem(word));
  }
  return out;
}

export interface TermCounts {
  /** Term → occurrences in the text. */
  readonly terms: Map<string, number>;
  /** Number of terms (the BM25 document length). */
  readonly length: number;
}

export function termCounts(text: string): TermCounts {
  const terms = new Map<string, number>();
  const tokens = tokenize(text);
  for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1);
  return { terms, length: tokens.length };
}
