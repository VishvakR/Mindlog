# @mindlog/index-vector

The vector index port and an exact flat index (PLAN 11.1, ADR-0008).

## Public API

- `VectorIndex<M>`: `upsert(id, vector, meta)`, `remove(id)`, `search(query, k, filter?)` and `size`. Vectors are L2-normalised, so the score is cosine similarity.
- `FlatIndex<M>`: scans every vector, keeping them in one growing `Float32Array`.

## Invariants

- The filter runs during the scan, so `k` matches come back however many others it excludes.
- Equal scores are ordered by id. The same vectors always give the same answer, on every replica.
- A vector of the wrong size throws (a programmer error).

The memory engine keeps one `FlatIndex` per user scope in memory, built from the `m/(user, 'v')` rows and updated after apply. The persisted rows are the truth. A move to HNSW is planned past about 100K vectors per scope (the `shortcut:` comment in `flat-index.ts`).

Emits no metrics; callers time their searches.
