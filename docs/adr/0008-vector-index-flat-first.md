# ADR-0008: Vector index — exact flat index first, HNSW later

- Status: accepted
- Date: 2026-10-18
- PLAN: 11.1 (amended for phase 5), 12.4, 1 (recall p95 < 150 ms at 10K memories)
- References: [mem0.md](../references/mem0.md)

## Context

PLAN 11.1 proposes `hnswlib-node` with non-identical graphs across replicas. That adds a native build to CI and Docker, and HNSW only pays off far above phase 5's target of 10K memories per scope. An exact scan of 10K × 384 float32 is about 4 M multiply-adds, a few milliseconds in JS.

## Decision

- `@mindlog/index-vector` exposes a `VectorIndex` port (`upsert`, `remove`, `search(query, k, filter)`) and a pure-TS `FlatIndex` (cosine on normalised vectors, filter applied during the scan, exact top-k).
- The persisted truth is the `m/(user, 'v', id)` rows (ADR-0031), written in apply. Each node keeps an in-memory `FlatIndex` per `(tenant, user)`, built lazily by scanning those rows and updated after apply from the `MemoryCommitted` event. Every query first reads the user's generation counter `m/(user, 's')`; a mismatch (snapshot install, missed event) rebuilds the index.
- Results are identical on every replica, which also makes the simulator's recall invariants exact.
- `shortcut:` comment in `FlatIndex`: move to HNSW when a scope passes ~100K vectors or the recall benchmark's p95 exceeds 50 ms of search time.

## Alternatives considered

- **hnswlib-node now**: native addon, non-deterministic graphs, unneeded at this scale.
- **Scan LevelDB on every query**: reads ~15 MB per 10K-memory recall.

## Consequences

- Memory per node grows by ~1.5 KB per cached vector; the cache is per scope and evicted LRU by scope count (`memory.vectorCacheScopes`).
- Search runs on the event loop; the recall benchmark watches it (CLAUDE.md §5).
