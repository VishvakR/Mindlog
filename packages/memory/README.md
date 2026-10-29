# @mindlog/memory

The agent memory engine (PLAN 12; ADR-0008, 0011, 0016, 0017, 0031, 0032).

## Public API

- **Apply**: `memoryCommitHandler` (body 20) and `memoryForgetHandler` (body 22).
  - A commit stores records and their indexes in one batch: vector, BM25 postings, df and stats, entities by normalised name, mentions and edges. It can also enqueue jobs and complete the job that produced it.
  - Forget is append-only. It sets `expiredAt`, then removes the memory from every index.
- **`MemoryEngine`**: works on one range (`MemoryRange`: proposer plus span reader).
  - `remember` runs the ingestion stages: normalize, chunk, extract, recognize, embed, importance, link-notes, trust. It then assembles and proposes the commit.
  - `recall` runs a named **recipe** (ADR-0011): `rag`, `vector`, `hybrid`, `hybrid_ppr` or `full` (default). The stages are parse (query entities), route (`specific`/`multihop`/`broad`), the recipe's retrievers (vector, keyword + entity, `ppr`, `theme`), weighted RRF, filter, optional cross-encoder rerank of the top 50, score, optional MMR (λ 0.7), then pack.
  - `ppr` runs Personalized PageRank over the 2-hop memory graph around the query entities and vector hits (entity and `@memory` nodes, ≤ 5,000), through a `PprRunner` (inline by default; the server passes a worker pool). `theme` finds label-propagation communities for broad queries.
  - Packing (`pack`, PLAN 13.6) is greedy by score per token, shortens items to leading sentences when they no longer fit, swaps once for value, and groups the context as Facts / Themes / Procedures / Recent episodes; it never exceeds the budget and reports `dropped` and `compressed`. `explain: true` adds each retriever's ranked ids and the themes.
  - Also `get`, `list`, `forget`, `history` (MVCC versions), `graph` (entity plus 1–2 hops) and `enrichWorker()` (the `memory.enrich` job worker).
- **`VectorCache`**: one `FlatIndex` per user scope, kept current from `CommandApplied`. It rebuilds when the scope's generation counter differs.
- **Building blocks**: `runStages` with `Stage`, `rrf`, `finalScore`, `recency`, `retention`, `pack`, `estimateTokens`, `mmr`, `classifyQuery`, `RECIPES`, `inlinePpr`, `matchesScope`, `MemoryReads` (incl. `memoryGraph`), and the key helpers.

## Degraded mode (PLAN 21)

- A stage whose model capability is unavailable, fails or times out uses its fallback.
- When extraction or embedding falls back, the raw passages are stored as `episodic` with a `memory.enrich` job, and the answer is `degraded: true`.
- Recall without an embedder uses the keyword and entity retrievers only (PPR seeds from query entities only, so it needs the recognizer); without the reranker it scores the fused ranks.
- Once the models are back, the enrich job commits the derived facts. They carry `derived_from` links, and the commit completes the job atomically.
- `async: true` takes the same path on purpose: it acknowledges fast and enriches later. It answers `BUSY` when the scope already holds `maxQueuedJobs` queued or leased jobs (ADR-0017).

## Invariants

- Model calls happen before proposing, on the node serving the range. Apply is deterministic, and the leader computes ids, vectors and BM25 terms.
- A user's memory, indexes and jobs share the prefix `tenant · 'm' · (user, …)`, so they stay in one range.
- Quarantined memories (from `web` sources) are left out of recall unless requested, and forgotten ones are never returned.

## Metrics

- `mindlog_memory_stage_seconds{pipeline,stage}`
- `mindlog_memory_degraded_total{pipeline}`
- `mindlog_memory_vector_rebuilds_total`
- Spans `memory.remember`, `memory.recall` and `memory.<pipeline>.<stage>`.
