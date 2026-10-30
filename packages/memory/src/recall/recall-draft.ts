import type { MemoryRecord } from '@mindlog/proto';
import type { RecallInput, RecallItem, RecallTheme } from '../types.js';
import type { Recipe, RetrieverName } from './recipes.js';
import type { QueryRoute } from './route.js';

/** Raw per-retriever scores of a candidate, kept for explain (not used by fusion). */
export type Signals = Partial<Record<RetrieverName | 'rerank', number>>;

/** What the recall stages fill in, in order (PLAN 12.4). */
export interface RecallDraft {
  readonly input: RecallInput;
  readonly recipe: Recipe;
  /** Physical time of the `ASOF` version, when reading the past. */
  readonly asOfMs?: number | undefined;
  /** Candidate entity ids of the query's entities. */
  readonly queryEntities: readonly string[];
  /** Distinct entity names recognised in the query. */
  readonly entityNames: number;
  readonly route: QueryRoute;
  /** Ranked ids per retriever. */
  readonly lists: ReadonlyMap<string, readonly string[]>;
  readonly signals: ReadonlyMap<string, Signals>;
  readonly themes: readonly RecallTheme[];
  readonly fused: ReadonlyMap<string, number>;
  readonly records: readonly MemoryRecord[];
  /** Every scored candidate, best first (diversified when the recipe says so). */
  readonly ranked: readonly RecallItem[];
}

export function emptyDraft(input: RecallInput, recipe: Recipe, asOfMs?: number): RecallDraft {
  return {
    input,
    recipe,
    asOfMs,
    queryEntities: [],
    entityNames: 0,
    route: 'specific',
    lists: new Map(),
    signals: new Map(),
    themes: [],
    fused: new Map(),
    records: [],
    ranked: [],
  };
}

export function withSignal(
  signals: ReadonlyMap<string, Signals>,
  hits: ReadonlyArray<{ id: string; score: number }>,
  signal: keyof Signals,
): Map<string, Signals> {
  const out = new Map(signals);
  for (const h of hits) out.set(h.id, { ...out.get(h.id), [signal]: h.score });
  return out;
}

export function withList(
  d: RecallDraft,
  name: string,
  ids: readonly string[],
): Map<string, readonly string[]> {
  return new Map([...d.lists, [name, ids]]);
}
