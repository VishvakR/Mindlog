# @mindlog/cache

The memory-aware semantic cache (PLAN 13.9, ADR-0012): agents store answers with the memories they used, and a later similar prompt gets the answer back until one of those memories is forgotten.

## Public API

- **Apply**: `cacheSetHandler(liveMemory)` (body 40) and `cacheInvalidateHandler` (body 41).
  - `CacheSet` stores the entry at `m/(user, 'c', id)` and one empty row per dependency at `m/(user, 'q', memory, id)`, and keeps a count at `m/(user, 'cn')`. Beyond `maxEntries` it evicts the oldest entries (ULID order) in the same batch. A dependency that is missing or forgotten fails the command (`NOT_FOUND`), checked through the `LiveMemory` port the memory engine supplies.
  - `dropDependents(ctx, tenant, user, memories)` deletes the entries depending on any of the memories, in the caller's batch. `MemoryForget` calls it.
- **`SemanticCache`** on one range (`CacheRange`: proposer plus span reader):
  - `store(range, scope, { prompt, answer, dependsOn?, ttlSeconds?, modelHint? }, call)` normalises the prompt, embeds it (query embedding) and proposes `CacheSet`. Without an embedder the entry is stored without a vector (`degraded`) and matches only its exact prompt.
  - `lookup(range, scope, prompt, threshold = 0.92)`: L1 is this node's map from the exact normalised prompt to an entry id, re-read from the range; L2 scans the scope's entries by cosine and asks the `SimilarityEvaluator` to confirm the best one against the threshold. Expired entries (TTL, HLC milliseconds) never hit.
  - `invalidate(range, scope, ids, call)` proposes `CacheInvalidate`.
- **`SimilarityEvaluator`** port with `cosineEvaluator` (exact prompts score 1, else the embeddings' cosine).

## Invariants

- Entries live in the user scope's range, so dependency invalidation is part of the same apply as the forget: no window in which a stale entry is served, identical on every replica.
- Every value in `CacheSet` (id, vector, expiry) is decided by the proposer; apply only checks and stores.
- Cache commands are proposed only at cluster version 6 (`CACHE_CLUSTER_VERSION` in `@mindlog/services`).
- Entries belong to the user scope; agent and session scopes share them.

## Limits

- L2 is a scan bounded by `maxEntries` (default 1,000 per scope); index entries in a `FlatIndex` if caches grow.
- Record-key dependencies (collections) arrive with phase 9; expired entries are removed by the cap, `CACHE.DEL` or the phase 8 `CacheJanitor`.

## Metrics

- `mindlog_cache_lookups_total{result="hit_l1"|"hit_l2"|"miss"}`
- `mindlog_cache_tokens_saved_total` (answer length / 4 on hits)
- Spans `cache.lookup`, `cache.store`.
