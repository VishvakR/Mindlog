# Phase 5 — Model service, memory engine core, jobs, MCP: exit-gate evidence

- Date: 2026-10-19
- PLAN: §24 Phase 5 (§4.3–4.5, §5.3–5.5, §8.5, §11.1–11.3, §12.1–12.5, §12.7, §14, §15.1–15.3, §21)
- Status: **built, awaiting sign-off**
- Decisions:
  - ADR-0008: an exact flat vector index first (HNSW later).
  - ADR-0016: models run before proposing, where the range leads.
  - ADR-0017: durable jobs in the scope's range.
  - ADR-0020: offline-first; models load only from the repo's `models/` folder.
  - ADR-0031: memory key layout and scope placement (amends PLAN 5.1).
  - ADR-0032: memory and job commands.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Offline run passes (container network disabled except between the services) | `scripts/offline-demo.sh`:<br/>1. Builds the node, the model service (models baked in) and the demo agent.<br/>2. Creates an API key offline.<br/>3. Starts everything on a compose network with `internal: true`.<br/>4. Checks that `1.1.1.1:443`, `8.8.8.8:53` and DNS for huggingface.co are unreachable.<br/>5. Runs the two-session agent.<br/><br/>Output: `no route out: ok`, then `session 1: stored [...] (degraded: False)`, then `session 2: context - For the record: I prefer dark roast coffee, black, no sugar.`, then `PASS`. | pass |
| Recall p95 < 150 ms at 10K memories | `scripts/bench-recall.sh 10000 300`: 10,000 memories in one scope through `MEM.ADD`, 300 timed `MEM.SEARCH` calls after 20 warm-up calls. Results:<br/>- With the real model service (ONNX MiniLM embeddings and GLiNER over gRPC): **p50 41 ms, p95 42.6 ms, p99 49.1 ms**.<br/>- With `FakeModels` over gRPC: p50 19.8 ms, p95 22.2 ms, p99 43.8 ms. | pass |
| Degraded mode verified by stopping the model service | 1. `test/integration/degraded.test.ts` stops a gRPC model service mid-run. `MEM.ADD` returns `degraded: 1` with an enrich job, and `MEM.SEARCH` still finds the memory by keyword. After the service restarts, the job adds the derived semantic fact (passes 3 of 3 runs).<br/>2. `scripts/offline-demo.sh` then runs `docker compose stop offline-models` and runs the agent again: `stored [...] (degraded: True)` … `PASS`. | pass |
| Deliverable: an MCP client remembers in session 1 and uses it in session 2, offline | `python/demo_agents` (MCP Python SDK) passed against a local node with real models and in the offline compose run. The stdio relay (`mindlog-server mcp`, the Claude Desktop path) was checked from a Python MCP client: it lists the five tools, and `recall` returns the preference. Claude Desktop itself was not driven; the setup is in `docs/demo/claude-desktop.md`. | pass (scripted client) |

## Other checks run

- **Full suites:** `pnpm lint`, `pnpm typecheck` and `pnpm test` (1,084 TypeScript tests, the opt-in benchmark skipped, plus 10 web tests) are green, as are Python (55 tests, ruff, `mypy --strict`) and `proto:lint`/`proto:breaking`.
- **Real models** (`pytest -m integration`): embeddings are normalised and semantic, GLiNER finds people and organisations, NLI flags the contradiction, and the reranker orders correctly. The TypeScript ↔ Python contract suite also runs against the real service.
- **Simulator:** `SIM_MEM=1` adds a memory workload, remember and forget through the real engine on each scope's leader, while ranges split and merge, nodes crash and the network partitions. After healing it checks:
  - every acknowledged memory exists;
  - acknowledged forgets are expired;
  - BM25 stats and document frequencies equal a recount from the live records;
  - search never returns a forgotten memory;
  - state hashes are equal on every member.

  Runs: 40 seeds during the build, then 200 `SIM_MEM=1` seeds, which found two failing seeds (84 and 197, below). After the fix: **200 `SIM_MEM=1` seeds and 200 plain seeds pass**, as do seed 141 and seeds 84 and 197, which are now regression tests (`MEMORY_REGRESSION_SEEDS`).
- **Simulator bug found (a phase 4 bug, fixed):** a range frozen for a merge recorded the requests it refused in its idempotency table, and the merge folds that table into the left range. Replicas that had applied different numbers of refusals before reaching the merge folded in different tables, so a retried request applied on some replicas and was skipped on others: different state (seed 197), or an acknowledged memory missing on the new leader (seed 84). Refusals now live under their own range-local tag that merges and splits never copy (ADR-0009 amended), with a statemachine test that failed before the fix.
- **Compatibility:** MEM.* passes with ioredis (`test/compat/ioredis-memory.test.ts`) and with redis-py over RESP2 and RESP3.
- **Dashboard:** checked against a node with real models, with these screenshots:
  - [recall playground](phase-5-recall.png), showing per-signal scores and the packed context;
  - [knowledge graph](phase-5-graph.png);
  - [memory explorer](phase-5-memory.png), showing a memory's entities and history.

  Building the screenshots found two bugs, both fixed test-first:
  - the dashboard listed no scopes on a real router;
  - without an LLM the graph had no edges, and GLiNER tagged "I" and verbs as entities.
- **Models stay local:** the downloader writes only to `python/model_service/models/` (Hugging Face's cache included). The global `~/.cache/huggingface` was byte-for-byte unchanged after the download.

## Phase 5 checklist (PLAN 24)

| Task | Where |
|---|---|
| Model service: gRPC, micro-batcher, embeddings, GLiNER, NLI, reranker, extraction (heuristic, or llama-cpp with a JSON grammar), health, admission control, Dockerfile with the models, `MODELS.md` | `proto/mindlog/v1/models.proto`, `python/model_service` |
| `@mindlog/models-client`: ports, gRPC adapter, circuit breaker, fakes | `packages/models-client` |
| `index-vector`, `index-text`, `index-graph` (adjacency, 1–2 hop walk), updated in apply | `packages/index-*`, `packages/memory/src/apply` |
| `@mindlog/jobs`: durable queue, leases, retries, dead letter, leader-only execution | `packages/jobs`, `RangeJobs` in `packages/server` |
| `@mindlog/memory`: ingestion stages 1, 3–9, 11–13; recall stages 1, 3 (vector, keyword, entity), 4, 5, 7, 9; sync, async and degraded modes | `packages/memory` |
| Scopes and scope placement; `MEM.*` (add, search, get, forget, history); REST mirror | ADR-0031, `packages/services/src/memory`, `packages/adapter-resp/commands/memory.json`, `/api/memory/*` |
| `@mindlog/adapter-mcp`: stdio and Streamable HTTP, tools `remember`, `recall`, `forget`, `history`, `graph_query`, resources, the `recall-context` prompt, API-key auth | `packages/adapter-mcp`, `ApiKeyService`, `mindlog-server apikey` and `mcp` |
| Dashboard: Memory explorer, Knowledge graph (basic), Recall playground (basic) | `web/src/pages/{memory,graph,recall}-page.tsx` |
| `python/demo_agents`: an agent using MCP | `python/demo_agents`, `scripts/offline-demo.sh`, `docs/demo/claude-desktop.md` |

Also fixed:
- the lock resolver was never started on nodes with cross-range transactions (phase 4 bug);
- the frozen-range idempotency bug above (phase 4 bug);
- found in review: async `remember` now answers `BUSY` when a scope holds `maxQueuedJobs` queued jobs (ADR-0017 promised it), and memory requests and API keys refuse the reserved `$system` and `$node` tenants.

Cluster-version gating now covers memory and job commands (≥ 5) and transactions (≥ 4).

## Not done, or done differently

- **Redact (ingestion stage 2):** not built; there is no tenant PII policy yet.
- **Reranking in recall, MMR, token-budget compression and PPR:** phase 6. The reranker model is served but not used by recall yet.
- **Extraction quality:** without a GGUF model (`EXTRACT_GGUF`), facts are statement sentences and entity edges are co-mentions (`mentioned_with`). With llama-cpp they are extracted relations. The LLM path has not been run in this phase.
- **HNSW:** not built. The exact flat index meets the gate (ADR-0008) and has a `shortcut:` marker for when a scope passes about 100K vectors.
- **Cluster views of memory:** `MemoryService.scopes` lists only the scopes on ranges this node holds (marked `shortcut:`). Memory writes on a cluster wait until PD reports cluster version 5.
- **MCP:** stateless, so there are no resource subscriptions or notifications yet (the change stream comes later).
- **Simulator scale:** small runs only, at the user's direction (see above). Maelstrom and the chaos runs were not repeated in this phase.
- **Model config:** the planned per-capability `enabled` switches in `models:` were not built; a capability is off when its model is not in `models/`.
- **No independent review:** the whole-branch review was done by the author, not a fresh reviewer. It found the two review fixes listed above.
