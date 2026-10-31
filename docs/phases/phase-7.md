# Phase 7 — Log-native features: exit-gate evidence

- Date: 2026-10-31
- PLAN: §24 Phase 7 (§13.1–13.5, §6.3)
- Status: **built, awaiting sign-off**
- Decisions:
  - ADR-0013: a branch is a fork version plus its own key space in main's layout; reads overlay it on main at the fork; merges are planned on the leader and applied only if main has not moved; open branches pin GC.
  - ADR-0015: conflicts are detected before commit with NLI, quarantine the new fact by default, and resolve by ending validity, never by deleting. Tuned in this phase: θ_c 0.95 and a 0.5 similarity gate.
- Scope choices by the user:
  - The contradiction set is hand-written (personal-fact profiles in the LoCoMo style), not mined or taken from an NLI corpus.
  - Simulator and eval runs use 100–300 seeds or items, not 10,000. The branch gate ran **300 seeds**.

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| The demo runs end to end from a script | `scripts/phase7-demo.sh` (Docker `offline` profile, no route out) runs `python -m demo_agents.phase7`. Two agents, each with its own API key, remember "The user is vegetarian." and "The user eats steak every weekend." A conflict is raised and the newer fact is quarantined. A human resolves it through `POST /api/memory/resolve`, the endpoint the dashboard's Conflicts inbox uses. An agent creates branch `trip-plan`, remembers a plan on it (seen on the branch, not on main), and merges it. Recall `as_of` a time before the merge does not see the plan. **8/8 checks passed.** | pass |
| Conflict F1 reported | `uv run python -m evals.run --suite conflicts` on 320 pairs (100 contradict, 100 entail, 100 neutral facts about the same person, 20 dated changes), each pair in its own scope, real NLI (DeBERTa-v3-xsmall) and embeddings (MiniLM). **End-to-end F1 0.92** (precision 0.87, recall 0.98). Report: [`docs/evals/phase-7.md`](../evals/phase-7.md). | pass |
| Branch tests pass the simulator | `SIM_BRANCH=1 scripts/sim.sh 300 4`: **300 seeds pass**. That is the user's scale for this phase; PLAN asks for 10,000. | pass at 300 seeds |

### Conflict detection: what the eval changed

The first end-to-end run, at the ADR's starting defaults (θ_c 0.80, no gate), had F1 0.855: recall 1.0, but 30% of the neutral pairs raised a conflict. The NLI model calls unrelated facts about one person contradictions. One example was "Alice works at Acme in Lisbon" against "Alice eats steak every weekend", scored 0.98; the dashboard check below showed the same thing.

The sweep runs straight against the model service, over thresholds, aggregations and cosine gates. Its best setting is max over both directions, a 0.5 cosine gate and θ_c 0.95. Chosen on the even pairs, that same setting scores F1 0.97 on the odd ones. With it shipped, the end-to-end results are:

| | precision | recall | F1 | neutral pairs raising a conflict | entail | dated changes raising a conflict | dated changes superseded |
|---|---|---|---|---|---|---|---|
| θ_c 0.80, no gate | 0.746 | 1.0 | 0.855 | 30% | 4% | 0% | 100% |
| **θ_c 0.95, gate 0.5 (shipped)** | 0.875 | 0.98 | **0.92–0.925** | 10% | 4% | 0% | 100% |

The two runs of the shipped setting differ by one pair.

The set is small and ours, so these numbers show that the gate and threshold help on the kinds of errors seen. They do not show how the model does on real dialogue.

## Other checks run

- **Full suites:**
  - TypeScript: `pnpm lint`, `pnpm typecheck` and `pnpm test` pass (1,193 tests, one opt-in benchmark skipped, plus 13 web tests). `pnpm test:coverage` gives statements 90.6%, branches 80.1%, functions 91.6% and lines 93.7%. `pnpm lint:commits` passes.
  - Python: 66 tests pass, and ruff and `mypy --strict` pass over `model_service`, `mindlog_proto/tests`, `evals` and `demo_agents`.
  - Protobuf: `pnpm proto:lint` and `pnpm proto:breaking` pass. The new command bodies are 24, 25 and 30–32, gated by cluster version 7.
- **Phase 6 regressions, small:**
  - `test/integration/degraded.test.ts` passes.
  - `scripts/bench-recall.sh 1000 100`:
    - FakeModels: `hybrid_ppr` p95 15.7 ms, `full` 16.1 ms.
    - Real model service: `hybrid_ppr` p95 43.3 ms, `full` 83.8 ms.
    - With real models, seeding the 1,000 memories took 55 s, NLI conflict checks included.
- **Dashboard,** checked against a node with real models, seeded over RESP:
  - [Conflicts inbox](phase-7-conflicts.png) and [Branches](phase-7-branches.png), with a diff and merge policies.
  - Time travel, with the slider over the scope's lifetime.
  - Live feed, where events arrived while writes ran, including a branch write.
  - The Conflicts inbox is where the false positives that drove the tuning above showed up.
- **Bugs found while building, fixed:**
  - Apply writes its batch even when a handler returns an error. The branch merge and branch forget handlers could have written half a change on a failure; every handler now checks everything before its first write.
  - Forwarded memory requests are parsed again on the leader. A transform that produced a `bigint` broke `ASOF` by log index with `INTERNAL`. Parsed values now stay JSON.
- **`pnpm audit`:** 25 advisories, in zod, fastify, undici, body-parser, fast-uri, qs, glob, minimatch, deepmerge, systeminformation and @hono/node-server. They are all in dependencies that predate this phase; phase 7 added no npm dependency. They are not addressed here.
- **Load flakes:** `embedded-pd.test.ts` (DBSIZE after a split, the known phase 4 flake) and `test/integration/trace.test.ts` each failed once under full-suite load and passed on reruns.

## Phase 7 checklist (PLAN 24)

| Task | Where |
|---|---|
| Conflict detection, records, policies, `MEM.CONFLICTS`/`MEM.RESOLVE`, MCP tools; labelled set and tuning | `packages/memory/src/ingest/{conflicts,conflict-stage}.ts`, `apply/{conflict-writes,review-handlers}.ts`, MCP `conflicts`/`resolve_conflict`, `python/evals/src/evals/conflict_{pairs,eval}.py`, ADR-0015 |
| `@mindlog/branching`: metadata, overlay reads, branch-local indexes, CRDT merge planner with conflict checks, `MEM.BRANCH/MERGE/DROP/DIFF`, GC pinning | `packages/branching`, `packages/memory/src/{branches.ts,read/overlay-reads.ts,apply/branch-handlers.ts,read/open-forks.ts}`, `packages/kv/src/jobs/gc-job.ts` (`pinned`), ADR-0013 |
| `ASOF` (index and time), index-time table, `VALID_AT` | `packages/memory/src/read/memory-reads.ts` (`at`), `memory-engine.ts` (`#version`), `m/(user,'ix',index)`, `recall-stages.ts` (`validAt`) |
| Provenance, trust policy, quarantine, taint cascade | `packages/memory/src/ingest/text.ts` (`trustOf`, `minTrust`), `MEM.TRUST`, `MEM.FORGET SOURCE` (source-ref and derived-from indexes), `python/model_service/.../extract.py` (quoted input) |
| Change streams: `MEM.WATCH`, MCP subscriptions, SSE, resumable cursors | `packages/services/src/memory/change-feed.ts`, RESP push frames, `GET /api/realtime`, MCP `subscriptions/listen` |
| Dashboard: Time travel, Branches, Conflicts inbox, Live feed | `web/src/pages/{time-travel,branches,conflicts,live}-page.tsx`; quarantine review on the Memory page |
| Simulator invariants for branch isolation and merge determinism; CRDT property tests | `test/sim/branch-load.ts` (plus the scenario's replica state hashes), `packages/branching/test/crdt.test.ts` |
| ADR-0013, ADR-0015 | `docs/adr/` |

## Not done, or done differently

- **Simulator scale:** 300 seeds, not 10,000 (the user's choice).
- **Per-scope conflict policy:** the policy is configured per node (`memory.conflicts.policy`). A per-scope policy record is future work.
- **Change streams:**
  - A cursor resumes only from a 1,000-event in-memory tail per range. After a restart, or a longer gap, the subscriber gets `resync` instead of a replay from the Raft log (marked `shortcut:`).
  - A stream is served from a replica on the node it connects to. Forwarding streams across nodes is not built.
  - `MEM.WATCH` has no `UNWATCH`; it ends when the connection closes or resets.
- **Branches:**
  - Branch recall is brute force over main at the fork plus the branch, and builds its vector index per query.
  - Remember on a branch skips conflict detection (facts are checked at merge) and enrichment jobs: async remember is refused, and a degraded branch write stays raw.
  - The CRDT field merges cover trust, validity and expiry. Tags and importance never change after a write yet, so they have nothing to merge until phase 8's evolution.
- **Taint cascade:** forgets; it does not re-derive what was built from the source.
- **Old records:** memories committed before this phase have no source-ref or derived-from rows, so a taint cascade does not reach them. No production data exists, so there is no backfill.
- **`ASOF` beyond GC retention:** reads what is left; history older than retention (10 minutes for MVCC by default, except what an open branch pins) is gone.
- **No independent review:** the branch was reviewed by its author only.
