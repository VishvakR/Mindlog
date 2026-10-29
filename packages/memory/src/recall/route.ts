import type { RetrieverName } from './recipes.js';

/** What a query asks for (ADR-0011): one thing, a link between things, or an overview. */
export type QueryRoute = 'specific' | 'multihop' | 'broad';

const BROAD =
  /\b(summari[sz]e|summary|overview|overall|in general|generally|everything|anything|what do (?:you|i) know|tell me about (?:me|myself)|themes?|topics?|patterns?|habits?|usually|tend to)\b/iu;

/** A heuristic, model-free routing of the query (LightRAG's specific/broad split). */
export function classifyQuery(query: string, entityNames: number): QueryRoute {
  if (entityNames >= 2) return 'multihop';
  if (entityNames === 0 && BROAD.test(query)) return 'broad';
  return 'specific';
}

/** RRF weights per retriever for a route (PLAN 12.4: theme 1.5 broad, ppr 1.2 multi-hop). */
export function routeWeights(route: QueryRoute): Partial<Record<RetrieverName, number>> {
  if (route === 'broad') return { theme: 1.5 };
  if (route === 'multihop') return { ppr: 1.2 };
  return {};
}
