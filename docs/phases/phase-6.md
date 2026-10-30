# Phase 6 — Advanced retrieval, packing, semantic cache, eval harness: exit-gate evidence

- Date: 2026-10-30
- PLAN: §24 Phase 6 (§11.3, §12.4–12.5, §13.6, §13.9, §22.7)
- Status: **built, awaiting sign-off**
- Decisions:
  - ADR-0011: weighted RRF fusion, query routing, rerank as relevance, MMR, named recipes.
  - ADR-0012: the semantic cache lives in the scope's range, and forgetting a memory drops the entries that used it inside the same apply (a departure from PLAN 13.9's change-stream invalidation).
- Scope choices by the user:
  - The evals measure **retrieval** (recall and NDCG of the evidence turns), not QA accuracy.
  - The baselines are Mindlog's own ablations plus an in-harness plain RAG; Mem0, Cognee and Redis AMS are a recorded gap.
  - The gate runs a seeded, stratified 100-question LongMemEval_s subset plus all of LoCoMo (`--full` runs all 500 questions).
- Full report: [`docs/evals/phase-6.md`](../evals/phase-6.md) (raw numbers in `phase-6.json`).

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Hybrid + PPR beats vector-only on LongMemEval in our harness | `uv run python -m evals.run --suite all` against one node with the real model service (MiniLM embeddings, GLiNER, the MiniLM cross-encoder), 100 LongMemEval_s questions (seed 6), 25,456 memories in 100 scopes. Turn level, k = 10:<br/>- `vector`: recall_any 0.87, NDCG 0.552<br/>- `hybrid_ppr`: **recall_any 0.94, NDCG 0.675**<br/>- `full` (the default): recall_any 0.96, NDCG 0.806 | pass |
| Cache false-positive rate < 2% at the chosen threshold | `--suite cache`: 209 distinct LongMemEval questions stored with `CACHE.SET`; 627 reworded repeats of them (3 templates each) and 210 held-out different questions looked up with `CACHE.GET`, all through the real embedder. A false hit is a different question that hits any entry, or a repeat that hits another question's entry; each is rated over its own lookups and the larger counts. At the shipped default **0.92: 1.4% false hits on different questions (3 of 210), 0% wrong entries on repeats, 98.2% hit rate**. The highest-hit threshold under 2% is 0.90 (1.9%, 99.4% hits), with no margin, so the default stays 0.92. | pass (at 0.92) |

### Recall ablation, LongMemEval (turn level)

| recipe | recall_any@5 | recall_any@10 | recall_all@10 | NDCG@10 | session recall_any@10 | p50 / p95 |
|---|---|---|---|---|---|---|
| `rag` (vector, relevance only) | 0.76 | 0.84 | 0.55 | 0.539 | 0.94 | 13 / 21 ms |
| `vector` (vector, full score) | 0.78 | 0.87 | 0.59 | 0.552 | 0.94 | 13 / 16 ms |
| `hybrid` (+ keyword, entity) | 0.92 | 0.94 | 0.75 | 0.686 | 0.99 | 32 / 52 ms |
| `hybrid_ppr` (+ PPR) | 0.90 | 0.94 | 0.77 | 0.675 | 0.99 | 40 / 72 ms |
| `full` (+ theme, rerank, MMR) | 0.94 | 0.96 | 0.79 | 0.806 | 1.00 | 1048 / 2074 ms |

Read honestly:
- The gain over vector-only comes from the keyword and entity retrievers. **PPR on its own adds nothing measurable here**: `hybrid_ppr` and `hybrid` are within a question or two of each other (NDCG 0.675 against 0.686; recall_all 0.77 against 0.75). On LoCoMo (below) PPR lowers recall on category 1 questions and raises it on category 3.
- The cross-encoder rerank is what lifts `full`, but on CPU it costs about 1 s per query on LongMemEval's long turns (50 pairs of up to 512 tokens). Queries ran one at a time, so this is model time, not queueing.

### Recall ablation, LoCoMo (turn level, 1,535 questions, 5,882 memories)

| recipe | recall_any@10 | recall_all@10 | NDCG@10 | session recall_any@10 | p50 / p95 |
|---|---|---|---|---|---|
| `rag` | 0.517 | 0.406 | 0.312 | 0.862 | 13 / 15 ms |
| `vector` | 0.525 | 0.415 | 0.309 | 0.868 | 13 / 15 ms |
| `hybrid` | 0.613 | 0.479 | 0.334 | 0.911 | 35 / 44 ms |
| `hybrid_ppr` | 0.597 | 0.467 | 0.346 | 0.906 | 50 / 62 ms |
| `full` | 0.712 | 0.576 | 0.548 | 0.922 | 698 / 1355 ms |

LoCoMo agrees with LongMemEval: hybrid beats vector-only clearly, `full` is best, and PPR moves NDCG up slightly (0.346 against 0.334) but recall down (0.597 against 0.613). By category (recall_any@10), PPR goes from 0.68 to 0.63 on category 1 and from 0.36 to 0.39 on category 3. **PPR needs tuning before it earns its place in the default recipe**: its seeds and the 1.2 multi-hop weight were taken from HippoRAG and the PLAN, not fitted. The harness now makes that a measurable change.

### Packing (LongMemEval, share of questions with an evidence turn in the packed context)

| budget (tokens) | `rag` | `full` |
|---|---|---|
| 250 | 0.03 | 0.06 |
| 500 | 0.19 | 0.17 |
| 1000 | 0.57 | 0.50 |
| 2000 | 0.90 | 0.91 |
| 4000 | 0.93 | 0.99 |

Tokens used stayed under every budget (the pack property test checks the context never exceeds it). `full` wins at 4000 tokens, but `rag` packs evidence slightly more often at 500–1000. Packing is greedy by score per token, so short, mildly relevant memories crowd out long evidence turns when the budget is tight.

## Other checks run

- **Full suites:** `pnpm lint`, `pnpm typecheck` and `pnpm test` (1,122 TypeScript tests, the opt-in benchmark skipped, plus 12 web tests) are green. Python is green too: 63 tests, ruff and `mypy --strict` over `model_service`, `mindlog_proto/tests` and `evals`. `pnpm lint:commits` passes.
- **Recall latency at 10K memories** (`scripts/bench-recall.sh 10000 300`). PLAN 1 sets the 150 ms target without rerank, so the bench now gates on `hybrid_ppr` and reports `full` alongside:
  - with the real model service: `hybrid_ppr` **p50 106.8, p95 140.4, p99 153.5 ms**; `full` p50 294.5, p95 370.4, p99 473.6 ms;
  - with `FakeModels`: `hybrid_ppr` p95 31 ms, `full` p95 31.9 ms.

  `hybrid_ppr` passes, but with little margin, and about 3× phase 5's 42.6 ms on the same bench. The extra time has not been profiled yet.
- **Simulator:** 100 plain seeds and 100 `SIM_MEM=1` seeds (101–200) pass. The memory workload now also stores cache entries that depend on memories, forgets some of them, and checks after healing that no cache entry depends on a forgotten memory and that every acknowledged entry whose memories are live still exists. While it was being built, it found a retried `CACHE.SET` reporting an id it had never stored (fixed: the id now comes from the first attempt's result).
- **Cache race found in design, fixed:** a `CacheSet` applied after a forget of one of its memories would have kept a stale entry. Apply now refuses a missing or forgotten dependency (`NOT_FOUND`), with a test.
- **Model service bug found by the gate run, fixed:** when a caller's deadline passed, the micro-batcher's attempt to deliver that caller's result raised `InvalidStateError` and killed the batch worker, stranding every other request in the batch. Under the eval's load this cascaded: the circuit breaker opened, writes were stored without embeddings, and the first gate run reported 0 for the vector recipes. The batcher now skips callers that have gone, with a regression test that hangs without the fix. The harness now waits for enrichment jobs to drain before scoring and reports how many writes were degraded (6,844 of 24,379 on LongMemEval, all enriched before scoring except two jobs that failed five attempts).
- **Phase 4 flake seen, not fixed:** `embedded-pd.test.ts` ("keeps serving MGET, DBSIZE and writes across ranges after a split") failed once in a full run with DBSIZE 5 instead of 6. It passed six times alone and in the next full run. The likely cause is that DBSIZE fans out over the directory's ranges (`routed-kv.ts`), and just after a split the directory can still list the old, wider range, whose replica now counts only its own half. The fix belongs in the router (a scatter call should be refused on a stale span and retried) and is left for a phase 4 follow-up.
- **Dashboard:** the [recall playground](phase-6-recall.png) checked against a node with real models, showing the recipe picker, the route, a column per retriever, every score signal and the packing meter. The real-model check found that MMR could rank unrelated memories above a relevant near-duplicate, because raw scores were on different scales; scores are now min-max scaled before MMR.

## Phase 6 checklist (PLAN 24)

| Task | Where |
|---|---|
| PPR retriever in a worker thread with node caps | `packages/index-graph/src/{csr,ppr}.ts`, `packages/memory/src/recall/ppr.ts`, `packages/server/src/bootstrap/ppr-pool.ts` (Piscina, bounded queue, `pprMaxNodes` 5000) |
| Theme retrieval (on-demand entity communities) and query routing | `packages/index-graph/src/communities.ts`, `packages/memory/src/recall/{theme,route}.ts` |
| Weighted RRF, final score, MMR, cross-encoder rerank | `packages/memory/src/recall/{recipes,rerank,mmr,recall-stages}.ts`, ADR-0011 |
| Token-budget packing with groups and compression; `MEM.PACK`; MCP `recall` returns packed context | `packages/memory/src/recall/pack.ts`, `MEM.PACK`, `POST /api/memory/pack`, MCP `recall` (`tokens`, `budget`, `dropped`) |
| `@mindlog/cache` with dependency tracking and invalidation; `CACHE.*`; MCP `cache_lookup`/`cache_store` | `packages/cache`, `proto/mindlog/v1/cache.proto` (bodies 40, 41; cluster version 6), ADR-0012 |
| `python/evals`: LongMemEval and LoCoMo runners, ablations, packing curves, cache metrics, results to `docs/evals/` | `python/evals`, `docs/evals/phase-6.{md,json}` |
| Dashboard Recall playground: per-retriever results, scores, packing | `web/src/pages/recall-page.tsx`, [screenshot](phase-6-recall.png) |
| ADR-0011, ADR-0012 | `docs/adr/` |

## Not done, or done differently

- **External baselines:** Mem0, Cognee and Redis Agent Memory Server were not run (the user's choice); plain RAG is the in-harness baseline.
- **QA accuracy:** not measured; the harness scores retrieval of the labelled evidence turns only.
- **Cache paraphrases are templated:** positives are three rewordings of a stored question made by templates, and negatives are other LongMemEval questions. Real user paraphrases would be harder.
- **Session timestamps are not replayed:** turns are stored at ingestion time, so recency does not reflect the dataset's dates, and temporal-reasoning questions get no help from it.
- **Cache invalidation by record keys:** only memory dependencies are tracked (inside apply, ADR-0012). Record-key dependencies wait for collections in phase 9.
- **Cache in the recall pipeline:** the `CheckCache` and `RecordRecall` stages are not wired; the cache is reached through `CACHE.*` and the MCP tools. There is no REST mirror for `CACHE.*`.
- **Cache evaluator:** cosine only; the `SimilarityEvaluator` port has no cross-encoder implementation yet.
- **Cache TTL:** checked when an entry is read; expired entries are not removed by a replicated expiry command yet.
- **Compression:** extractive (leading sentences, marked `shortcut:`); no summarizer model is served.
- **Rerank latency:** the default `full` recipe costs 370 ms p95 at 10K short memories and about 1 s per query on LongMemEval's long turns with the CPU cross-encoder. PLAN 1's 150 ms target excludes rerank, and `hybrid_ppr` meets it. Whether `full` should stay the default is open.
- **PPR tuning:** PPR does not yet improve on `hybrid` (above); its weights are not fitted to the eval sets.
- **No independent review:** the branch was reviewed by its author only.
