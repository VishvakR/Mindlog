# @mindlog/memory

The agent memory engine (PLAN 12–13; ADR-0008, 0011, 0013, 0015, 0016, 0017, 0031, 0032, 0033).

## Public API

- **Apply**: `memoryCommitHandler` (body 20), `memoryForgetHandler` (22), `conflictResolveHandler` (24), `memoryTrustHandler` (25), `branchCreateHandler`, `branchMergeHandler` and `branchDropHandler` (30–32). Every handler checks everything before its first write, since a batch is written even when the result is an error.
  - A commit stores records and their indexes in one batch: vector, BM25 postings, df and stats, entities by normalised name, mentions, edges, the source-ref and derived-from indexes, and an index-time row for `ASOF`. It can also enqueue jobs, complete the job that produced it, end the validity of facts it supersedes, and store the conflicts it raises.
  - Forget is append-only. It sets `expiredAt`, then removes the memory from every index. With a source reference it first walks the taint cascade (everything from that source and derived from it), bounded by `maxCascade`.
  - Commands with `Command.branch` set write the branch's own space `m/(user,'w',name,…)`; a main memory changed on a branch gets a masking copy there.
  - Lifecycle (ADR-0033): `memoryMaintainHandler` (21) applies a worker's evolutions (each a new version, the old one kept at `m/(user,'rv',id,version)`), tier moves, entity summaries, re-embedded vectors and pins, with the worker's checkpoint, its enqueued jobs and its own completion; `memoryRecallStatsHandler` (23) raises the strength of recalled memories by the spacing rule (PLAN 13.7). Both are main-only.
  - Every main commit keeps the scope's `ScopeLifecycle` at `m/(user,'cs')` (hot/cold counts, trigger counts, embedding model, checkpoints) and enqueues the scope's consolidation tick if none is scheduled.
- **`MemoryEngine`**: works on one range (`MemoryRange`: proposer plus span reader).
  - `remember` runs the ingestion stages: normalize, chunk, extract, recognize, embed, importance, link-notes, trust (by source: tools off the allow-list and untrusted domains are quarantined), and detect-conflicts (NLI against similar facts, the policy and the temporal rule; ADR-0015). It then assembles and proposes the commit.
  - `recall` runs a named **recipe** (ADR-0011): `rag`, `vector`, `hybrid`, `hybrid_ppr` or `full` (default). The stages are parse (query entities), route (`specific`/`multihop`/`broad`), the recipe's retrievers (vector, keyword + entity, `ppr`, `theme`), weighted RRF, filter, optional cross-encoder rerank of the top 50, score, optional MMR (λ 0.7), then pack.
  - `ppr` runs Personalized PageRank over the 2-hop memory graph around the query entities and vector hits (entity and `@memory` nodes, ≤ 5,000), through a `PprRunner` (inline by default; the server passes a worker pool). `theme` finds label-propagation communities for broad queries.
  - Packing (`pack`, PLAN 13.6) is greedy by score per token, shortens items to leading sentences when they no longer fit, swaps once for value, and groups the context as Facts / Themes / Procedures / Recent episodes; it never exceeds the budget and reports `dropped` and `compressed`. `explain: true` adds each retriever's ranked ids and the themes.
  - Recall, `get` and `list` take `asOf` (a log index or time: an MVCC read with a vector index built at that version) or a `branch` (its space over main at the fork, `OverlayReads`); recall returns facts valid now unless `validAtMs` names another time.
  - Review: `conflicts`, `resolve` (keep a, b or both) and `setTrust`.
  - Branches: `createBranch`, `branches`, `diffBranch`, `mergeBranch` (planned with `@mindlog/branching`, re-planned if main moved) and `dropBranch`.
  - Also `get`, `list`, `forget` (with `sourceRef` for the taint cascade), `history` (one entry per visible state: MVCC versions within retention plus the kept earlier versions), `graph` (entity plus 1–2 hops) and `enrichWorker()` (the `memory.enrich` job worker).
  - Lifecycle (`lifecycle-ops.ts`, ADR-0033): recalls are batched per scope and proposed as `MemoryRecallStats` every `recallStatsMs` (never for `ASOF` or branch reads); `includeCold` returns cold stubs with their full text from the blob segment, and recalling one moves it back hot (`promote`). Also `maintain`, `pin`, `lifecycle`, `jobs`, `consolidate` (enqueue workers now) and `invalidateCache`.
  - Tool traces: `remember({ toolTrace })` stores a `tool_trace` memory, arguments and results truncated to 500 characters each.
  - Memory cubes (`cube/`, PLAN 13.11): `exportCube` writes a `.mcube` (gzip tar: manifest with sha256 of each file, memories, entities, edges, branches; cold memories with their full text); `importCube` reads a `.mcube` or a COGX archive and remembers each memory from source `document`, ref `import:<name>`, so the trust policy applies.
- **`VectorCache`**: one `FlatIndex` per user scope, kept current from `CommandApplied`. It rebuilds when the scope's generation counter differs.
- **`oldestOpenFork(reader, span)`**: the version GC must keep for the range's open branches.
- **Cold segments**: `encodeSegment`, `decodeSegment` (checks the sha256), `segmentKey` and `stubText`; `ColdReads` keeps the last 16 decoded segments.
- **Lifecycle helpers**: `LIFECYCLE_JOBS` (worker kinds), `initialStrength` (`1 + 9 × importance` days), `strengthAfterRecall`, `retentionAt`.
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
- Quarantined memories are left out of recall unless requested, and forgotten ones are never returned.
- Conflicts, supersedes and merges never delete: the losing fact's `validTo` ends (world time), and history stays readable with `ASOF` and `VALID_AT`.
- Branch writes never touch main's keys or generation; a merge applies only to the main generation, and (from cluster version 8) the branch generation, it was planned at.
- A cold record keeps its stub, postings, mentions and links; its vector row is gone and its full record is in a content-addressed segment written before the command that names it. Followers never read the blob store.
- The vector cache indexes only vectors of the scope's current embedding model.

## Metrics

- `mindlog_memory_stage_seconds{pipeline,stage}`
- `mindlog_memory_degraded_total{pipeline}`
- `mindlog_memory_vector_rebuilds_total`
- `mindlog_memory_recall_stats_dropped_total`
- Spans `memory.remember`, `memory.recall` and `memory.<pipeline>.<stage>`.
