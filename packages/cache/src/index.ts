/**
 * @mindlog/cache — the memory-aware semantic cache (PLAN 13.9, ADR-0012):
 * replicated entries in the user scope's range, dependency invalidation inside
 * apply, and L1/L2 lookup with a pluggable similarity evaluator.
 */
export type { LiveMemory } from './apply/cache-handlers.js';
export { cacheInvalidateHandler, cacheSetHandler, dropDependents } from './apply/cache-handlers.js';
export { entryKey, entryPrefix } from './keys.js';
export { normalizePrompt } from './prompt.js';
export type {
  CacheCall,
  CacheHit,
  CacheLookup,
  CacheRange,
  CacheScope,
  CacheStoreInput,
  SemanticCacheConfig,
  SemanticCacheDeps,
} from './semantic-cache.js';
export { DEFAULT_CACHE_CONFIG, SemanticCache } from './semantic-cache.js';
export type { CacheQuery, SimilarityEvaluator } from './similarity.js';
export { cosineEvaluator, similarityOf } from './similarity.js';
