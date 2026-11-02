# Phase 8 — Consolidation and memory lifecycle: exit-gate evidence

- Date: 2026-11-01
- PLAN: §24 Phase 8 (§12.6, §12.7, §13.7, §13.11, §10.4)
- Status: **built, awaiting sign-off**
- Decisions:
  - ADR-0033:
    - One maintenance command (`MemoryMaintain`, body 21) and recall stats (body 23) at cluster version 8.
    - A self-rescheduling tick job per scope is the scheduler.
    - Cold segments are written to the blob store before the command that names them.
    - Stubs keep postings, entities and links.
    - The index generation is the scope's embedding model.
    - Sleep branches are named `sleep-<ms>`.
    - `S₀ = 1 + 9 × importance`.
    - The per-tenant budget is node-local.
  - ADR-0033 also changes ADR-0013's merge rule: a branch merge is fenced on the branch's generation too (see "Bugs found").
- Scope choices by the user:
  - The full PLAN list, cold tier on local disk and S3/MinIO.
  - Our own SigV4 over `fetch` rather than the AWS SDK.
  - The 30-day run as a TypeScript harness on a manual clock.
  - Simulator and evals at 100–300 seeds or items.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Forgetting eval beats LRU eviction | `scripts/lifecycle-eval.sh` (30 simulated days, 40 important facts recalled on days 3, 8 and 15, 10 noise episodes a day; LRU gets the same hot budget each day). With the model service, the forgetting curve recalls **18/40** important facts against **0/40** for LRU; 18/40 is also what `INCLUDE_COLD` finds, so it is the retrieval ceiling for these templated facts. With FakeModels: 40/40 against 0/40. Report: [`docs/evals/phase-8.md`](../evals/phase-8.md). | pass |
| 30-day run: memory count bounded, old-but-important facts still recalled | The same runs. Hot memories level off at about 140 from day 9 (141 → 120 by day 30 with real models); the important facts stay hot. The total grows (373 after 30 days), because faded memories go to the cold tier rather than being deleted; hard forgetting is off by default. | pass (hot count) |
| Sleep-time consolidation improves LongMemEval or reduces tokens at equal score (report either way) | `uv run python -m evals.run --consolidate` on 100 LongMemEval_s questions, strict crediting. Recall@10 drops 2–4 points and NDCG@10 2–6 points for all three recipes; packing with `full` packs more evidence at 500 and 1,000 tokens and less at 2,000 and 4,000. The run is partial: the model service exited after the first of three consolidation rounds (system disk nearly full), so 467 sleep jobs went dead. Report: [`docs/evals/phase-8.md`](../evals/phase-8.md#sleep-time-consolidation-on-longmemeval). | reported: no improvement |

## Other checks run

- **Full suites:**
  - TypeScript: `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (1,266 tests, two opt-in benchmarks skipped, plus 14 web tests).
  - `pnpm test:coverage`: statements 90.7%, branches 80.05%, functions 92.0% and lines 93.9%. Branches needed new tests to clear 80%.
  - The coverage run reported one unhandled rejection from `embedded-pd.test.ts` (a split finishing during shutdown), the known phase 4 flake.
  - Two earlier full runs timed out in `test/sim/sim.test.ts` while Docker Desktop was starting and pulling images. With Docker off, the same suite runs in 45 s.
  - Python: ruff, `mypy --strict` and pytest pass over `model_service` (28 tests) and `evals` (11 tests).
  - Protobuf: `pnpm proto:lint` and `pnpm proto:breaking` pass. The new bodies are 21 and 23, plus fields on existing messages, gated by cluster version 8.
- **Simulator:** `SIM_LIFE=1 SIM_BRANCH=1 scripts/sim.sh 300 4` passes 300 seeds: recall stats, cold moves and back, evolutions and pins, together with branches, under the usual faults. That run predates the branch-generation fix; after it, `SIM_BRANCH=1` and `SIM_MEM=1 scripts/sim.sh 50 2` pass (50 seeds, cut down at the end to spare the machine), and the fixed seeds replay clean.
- **Tests after the last fixes:** the consolidation and memory lifecycle/branch tests, `dashboard-roundtrip` and `crash-durability` pass. The last two each bind MCP port 8765, so they fail when run at the same time; each passes alone. `crash-durability` also needs `TMPDIR` off a full system disk.
- **Dashboard,** against a node with real models, seeded over RESP. To show the cold tier without waiting days, that node used a cold threshold of 0.9999:
  - [Jobs page](phase-8-jobs.png) with lifecycle counts and export/import.
  - [Version history](phase-8-history.png): an evolution, then a move cold and back.
  - [Recall with "Include cold"](phase-8-recall-cold.png).
- **S3 blob store:** tested against a local fake bucket that checks each request's SigV4 signature, and with the AWS documentation's signing-key example. The MinIO image could not be pulled here (Docker Hub and Quay refused), so no real MinIO or S3 run was done.

## Phase 8 checklist (PLAN 24)

| Task | Where |
|---|---|
| `@mindlog/consolidation`: scheduler, per-tenant budgets, checkpointed workers | `packages/consolidation` (`schedule.ts` `planTick`, `budget.ts` `ModelBudget`, `workers/tick.ts`), checkpoints in `MemoryMaintain`, deferral `JobComplete.defer_until_ms` |
| SleepTimeConsolidator on branches, auto-reject on excessive conflicts | `workers/sleep-time.ts`: branch `sleep-<ms>`, dry-run plan, drop past `maxConflicts` |
| EvolutionWorker, Deduplicator, ThemeBuilder (Louvain), EntitySummarizer | `workers/{evolution,dedup,themes,entity-summarizer}.ts`, `packages/index-graph/src/louvain.ts`, Python `Summarize` (`model_service/summarize.py`) |
| Forgetting curve, ForgettingWorker, cold tier on blob store, `INCLUDE_COLD` | `MemoryRecallStats` apply, `recall/recall-stats.ts`, `workers/forgetting.ts`, `packages/blob`, `cold-segment.ts`, `read/cold-reads.ts`, `recall-stages.ts` filter |
| Export/import `.mcube`, COGX import, tool-trace memories | `packages/memory/src/cube/{tar,mcube,cogx,cube-ops}.ts`, `ingest/tool-trace.ts`, `MEM.EXPORT/IMPORT/TRACE`, MCP `remember_tool_call` |
| ReembedWorker and index generations | `workers/reembed.ts`, `ScopeLifecycle.embed_model`/`reembed`, the vector cache's model filter |
| Dashboard: Jobs page, version history, cold-tier indicators | `web/src/pages/jobs-page.tsx`, `components/memory/version-history.tsx`, badges on the Memory and Recall pages |

## Bugs found while building, fixed

- **A branch write could be lost in a merge** (phase 7 code, found by the phase 8 simulator).
  - A merge plan names the branch memories it read, and apply only checked that main had not moved. A write to the branch between planning and applying was acknowledged, then dropped.
  - `BranchMerge.branch_generation` now fences the branch too (ADR-0033); seeds 49, 106, 139, 192 and 228 replay clean.
- **The phase 7 branch workload never ran its rare paths.** It compared `world.between()`, a float, to 0, so branch forgets, contradicting facts and drops almost never happened. It now uses `world.chance()`. That is how the merge race above surfaced.
- **Consolidation fed itself** (found on the dashboard).
  - Theme memories added entity mentions, the graph grew, the next tick rebuilt the themes, and so on.
  - Every new theme or learned-context memory also re-triggered evolution of the memories it linked.
  - Memories from source `consolidation` no longer count toward the graph, sleep or evolution triggers, and evolution ignores them. A test checks the next tick does not rebuild themes.
- **Eval harness:** themes and summaries that quote a fact filled the top 5, and FakeModels' word-overlap reranker favoured long summaries. The eval now asks for fact kinds and runs `hybrid` with FakeModels.

## Not done, or done differently

- **Simulator scale:** 300 seeds, not 10,000 (the user's choice).
- **Commands:** PLAN's `MemoryEvolve`, `TierChange`, `EntityUpdate` and `IndexGenerationSwitch` are one body, `MemoryMaintain` (ADR-0033).
- **Scheduling:**
  - The scheduler is a per-scope tick job (every 15 min while there is work).
  - The CacheJanitor runs at most once per tick, not every 5 min.
- **Budget:** the per-tenant model-time budget is node-local (`shortcut:`); a leader change starts a full bucket.
- **Themes:** Louvain only; Leiden's refinement step is not built.
- **Cold tier:**
  - Segments of memories that came back hot are not deleted (`shortcut:`).
  - Cold stubs keep their BM25 postings, so the keyword index does not shrink.
- **Hard forgetting:** it needs importance below 0.2, which heuristic importance never gives (it starts at 0.3); only dedup's halving gets there.
- **Re-embedding:** during a model change, the vector retriever sees only re-embedded and new memories until the ReembedWorker finishes; the other retrievers see everything.
- **Memory cubes:**
  - `vectors.bin` is not written; imports are re-embedded.
  - An import keeps text, kind, tags, validity and scope, but not importance, strength or version history.
  - Imports are quarantined by default (source `document`), as the trust policy says.
  - There is no `GET` download route: export is `POST /api/memory/export` (base64) and the dashboard turns it into a file.
- **Tool traces:** stored from source `agent` (ref `tool:<name>`), so they are not quarantined. Arguments and results are cut to 500 characters each so a trace stays one memory.
- **S3:** not run against real MinIO or S3 (see above).
- **Code size:** `memory-engine.ts` is still about 880 lines after the lifecycle and cube operations moved to their own files.
- **No independent review:** the branch was reviewed by its author only.
