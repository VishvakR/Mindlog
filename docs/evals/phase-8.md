# Phase 8 evals: forgetting and sleep-time consolidation

- Date: 2026-11-02
- Gate (PLAN 24): the forgetting eval beats LRU eviction; sleep-time consolidation improves LongMemEval or reduces tokens at equal score (report either way).

## Forgetting curve vs LRU eviction, 30 simulated days

Harness: `scripts/lifecycle-eval.sh` (`test/bench/lifecycle.test.ts`). It runs one scope in-process on a manual clock:
- Day 0: 40 important preferences ("I always prefer aisle seats for flights number 0.", importance 0.8).
- Every day: 10 noise episodes ("Today I saw a pigeon near the station on day 3.").
- The important facts are recalled on days 3, 8 and 15, then never again.

The two runs:
- **Forgetting curve:** the consolidation workers run as in production: the tick, forgetting into the cold tier at retention < 0.2, sleep-time, themes, and the rest.
- **LRU eviction:** consolidation is off, and each day the least recently used memories beyond the forgetting run's hot count for that day go cold. Both runs keep the same number of hot memories every day.

On day 30, each important fact is queried once, with the fact kinds only (themes and summaries that quote a fact are not the fact). A hit means the fact is in the top 5.

| Models, recipe | Forgetting curve: hot recall | LRU: hot recall | With `INCLUDE_COLD` (both) | Hot memories, day 10 → 30 | All memories, day 30 |
|---|---|---|---|---|---|
| FakeModels, `hybrid` | **40/40** | 0/40 | 40/40 | 139 → 139 | 370 (forgetting), 340 (LRU) |
| Model service, `hybrid` | **18/40** | 0/40 | 18/40 | 141 → 120 | 373, 340 |
| Model service, `full` (rerank) | **18/40** | 0/40 | 18/40 | 141 → 120 | 373, 340 |

Reading the table:
- **Forgetting beats LRU at the same budget.** By day 30 the important facts were last used 15 days ago. LRU evicted them in favour of two weeks of noise. The forgetting curve kept them hot: three spaced recalls raised their strength from 8.2 to about 16 days (×1.18, ×1.26, ×1.29), so on day 30 their retention was about 0.38, above the 0.2 cold threshold. The noise (importance about 0.4, strength about 4.6 days) faded below 0.2 after about 7 days and went cold.
- **18/40 is the real-model ceiling, not a forgetting loss.** With `INCLUDE_COLD`, both runs also find 18/40. With MiniLM, the 40 templated facts ("… for flights number 0" against "… for flights number 20") crowd each other out of the top 5. Forgetting reaches that ceiling; LRU reaches 0.
- **The hot count is bounded:** it is flat from day 9 at about 140, the noise of the last week or so plus the facts. The total keeps growing (370 after 30 days), because faded memories are moved to the cold tier rather than deleted. Hard forgetting is off by default, and heuristic importance never goes below 0.3, so even with it on nothing here would qualify (it needs < 0.2).
- **FakeModels needs `hybrid`:** its word-overlap reranker favours long consolidation summaries that repeat "I". `full` with real models has no such artifact and is reported above.
- The facts and noise are synthetic and written by us; the result shows the mechanism, not quality on real dialogue.

Raw per-day counts: `phase-8-forgetting-{fake,hybrid,full}.json`.

## Sleep-time consolidation on LongMemEval

`uv run python -m evals.run --consolidate --n 100 --workers 8 --recipes hybrid hybrid_ppr full`, with a node started with `MINDLOG_MEMORY__CONSOLIDATION__ENABLED=false` (the eval triggers the workers itself) and `MODEL_SECONDS_PER_HOUR=0` (no budget; with all 100 scopes in one tenant the default budget stalled the run). Full tables: [`phase-8-sleep.md`](phase-8-sleep.md).

| recipe | recall_any@10 before → after | NDCG@10 before → after |
|---|---|---|
| hybrid | 0.950 → 0.910 | 0.746 → 0.702 |
| hybrid_ppr | 0.940 → 0.910 | 0.717 → 0.702 |
| full | 0.930 → 0.910 | 0.741 → 0.685 |

- **Result: no improvement.** Retrieval drops by 2–4 points of recall@10 and 2–6 of NDCG@10. Packing with `full` is mixed: more evidence at 500 and 1,000 tokens (0.58 → 0.68, 0.74 → 0.76), less at 2,000 and 4,000, where the packer also uses fewer tokens (3,803 → 2,834 at 4,000).
- **The run is partial.** The model service exited at the end of the first of three consolidation rounds (the system disk was nearly full, about 400 MB free). Rounds 2 and 3 failed on summarize: 467 jobs went dead, and 45 sleep runs merged (2 were dropped for too many conflicts). So "after" is one sleep pass over each scope's first 200 turns plus dedup, themes, evolution and entity summaries, not full coverage.
- **Strict crediting.** A derived memory counts as a source turn only if it carries one of that turn's sentences (≥ 20 characters), in both passes. An earlier run with looser crediting (any `derived_from` source) showed `full` recall@10 0.93 → 0.95 and evidence at 1,000 tokens 0.56 → 0.70; most of that gain was summaries credited for turns they did not quote.
- **Load:** 15,431 of the ingest writes were degraded (stored without enrichment) because the model service was saturated by 8 workers; that applies to both passes.
- Not re-run at full coverage, by choice, to keep the machine's load down.
