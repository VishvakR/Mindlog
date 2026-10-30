# ADR-0012: Semantic cache with dependency invalidation inside apply

- Status: accepted
- Date: 2026-10-29
- PLAN: 13.9 (memory-aware semantic cache, **changed**), 6.1 (commands 40–41), 19.5 (cluster version)
- References: [gptcache.md](../references/gptcache.md)

## Context

PLAN 13.9 asks for a semantic cache of agent answers whose entries name the memories (and record keys) they were derived from, and which stops serving an entry once a dependency changes. It describes a `CacheInvalidator` that listens to `MemoryCommitted` events and proposes `CacheInvalidate` commands. Events are local and emitted after apply (CLAUDE.md 3.6), so that design leaves a window where a stale entry is served, needs a leader-only worker, and adds a command per change.

A memory and the cache entries that depend on it live in the same user scope, so in the same range (ADR-0031).

## Decision

- Commands `CacheSet = 40` and `CacheInvalidate = 41` (gated by cluster version 6). `CacheSet` carries everything the leader computed: the cache id, the normalised prompt, its embedding, the answer, dependency memory ids, optional record-key dependencies, a TTL and a model hint.
- Keys under the user scope (ADR-0031): `m/(user,'c',cacheId)` → entry, `m/(user,'q',memoryId,cacheId)` → reverse dependency index, `m/(user,'cn')` → entry count.
- `CacheSet` fails (`NOT_FOUND`) when a dependency is missing or already forgotten, read in the same apply through a `LiveMemory` port the memory engine supplies; otherwise a store ordered after the forget in the log would keep a stale entry.
- **Memory dependencies are invalidated inside apply**: `MemoryForget` (and any later command that supersedes a memory) deletes the entries depending on the memories it changes, and their reverse-index rows, in the same WriteBatch. No window, no extra command, identical on every replica.
- Record-key dependencies (collections, phase 9; they may live in other ranges) will be checked at read time: the entry is a miss if a dependency's current MVCC version is newer than the entry's HLC. Phase 6 entries depend on memories only.
- TTL is checked at read time against the HLC; expired entries are removed by the cap or by `CACHE.DEL`, and by the phase 8 `CacheJanitor`.
- Each scope holds at most `maxEntries` (default 1,000); `CacheSet` evicts the oldest entries in the same command (deterministic, no per-node LRU on L2).
- Lookup (`CACHE.GET`), following GPTCache: L1 is a per-node LRU from the hash of the normalised prompt to a cache id, re-checked against L2; L2 scans the scope's entries by cosine and a pluggable `SimilarityEvaluator` (cosine by default, cross-encoder optional) confirms the best candidate against the threshold (default 0.92).
- No new domain event in phase 6: change streams (phase 7) see the `MemoryForget` that dropped the entries.

## Alternatives considered

- **Event-driven `CacheInvalidator`** (PLAN 13.9 as written): stale reads between apply and the follow-up command, a worker to fence, and more Raft traffic.
- **Read-time version checks only**: needs every dependency's version read on each hit; fine for few record keys, wasteful for memories, and leaves dead entries around.
- **Cache in a separate range or tenant-wide**: dependency invalidation would become cross-range.

## Consequences

- `@mindlog/memory`'s apply calls `@mindlog/cache`'s `dropDependents`; both are domain packages, so the dependency is allowed.
- L2 lookup is a brute-force scan bounded by `maxEntries`; a vector index is needed if caches grow.
- Metrics: `mindlog_cache_lookups_total{result}` and `mindlog_cache_tokens_saved_total`; the false-positive rate is measured in `python/evals`.
- The simulator (`SIM_MEM=1`) checks after healing that no entry depends on a forgotten memory and that every acknowledged entry whose memory is live exists.
