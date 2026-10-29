/** Retrievers of the recall pipeline (PLAN 12.4 stage 3). */
export const RETRIEVERS = ['vector', 'keyword', 'entity', 'ppr', 'theme'] as const;
export type RetrieverName = (typeof RETRIEVERS)[number];

/** A named recall configuration (ADR-0011, CLAUDE.md 3.4). */
export interface Recipe {
  readonly retrievers: readonly RetrieverName[];
  readonly rerank: boolean;
  readonly mmr: boolean;
  /** Score by relevance alone, without recency, importance and retention (plain RAG). */
  readonly relevanceOnly: boolean;
}

const HYBRID: readonly RetrieverName[] = ['vector', 'keyword', 'entity'];

export const RECIPES = {
  rag: { retrievers: ['vector'], rerank: false, mmr: false, relevanceOnly: true },
  vector: { retrievers: ['vector'], rerank: false, mmr: false, relevanceOnly: false },
  hybrid: { retrievers: HYBRID, rerank: false, mmr: false, relevanceOnly: false },
  hybrid_ppr: { retrievers: [...HYBRID, 'ppr'], rerank: false, mmr: false, relevanceOnly: false },
  full: { retrievers: [...HYBRID, 'ppr', 'theme'], rerank: true, mmr: true, relevanceOnly: false },
} as const satisfies Record<string, Recipe>;

export type RecipeName = keyof typeof RECIPES;
export const RECIPE_NAMES = Object.keys(RECIPES) as [RecipeName, ...RecipeName[]];
export const DEFAULT_RECIPE: RecipeName = 'full';
