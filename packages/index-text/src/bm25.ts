export const K1 = 1.2;
export const B = 0.75;

/** Collection statistics of one scope. */
export interface Bm25Stats {
  readonly docs: number;
  /** Sum of document lengths; avgdl = totalLength / docs. */
  readonly totalLength: number;
}

export interface Posting {
  /** Occurrences of the term in the document. */
  readonly tf: number;
  /** Terms in the document. */
  readonly length: number;
}

/** One term's BM25 contribution (PLAN 11.2). */
export function bm25Score(tf: number, length: number, df: number, stats: Bm25Stats): number {
  if (stats.docs === 0 || tf === 0) return 0;
  const avgdl = stats.totalLength / stats.docs || 1;
  const idf = Math.log((stats.docs - df + 0.5) / (df + 0.5) + 1);
  return (idf * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * length) / avgdl));
}

/** Read access to a scope's postings; the key layout belongs to the caller (ADR-0031). */
export interface PostingReader {
  stats(): Promise<Bm25Stats>;
  df(term: string): Promise<number>;
  postings(term: string): AsyncIterable<Posting & { readonly id: string }>;
}

export interface TextMatch {
  readonly id: string;
  readonly score: number;
}

/** The `k` best documents for `terms`, best first; equal scores ordered by id. */
export async function searchBm25(
  reader: PostingReader,
  terms: readonly string[],
  k: number,
): Promise<TextMatch[]> {
  const stats = await reader.stats();
  if (stats.docs === 0) return [];
  const scores = new Map<string, number>();
  for (const term of new Set(terms)) {
    const df = await reader.df(term);
    if (df === 0) continue;
    for await (const p of reader.postings(term))
      scores.set(p.id, (scores.get(p.id) ?? 0) + bm25Score(p.tf, p.length, df, stats));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, k);
}
