---
description: What problem Mindlog solves, how it compares with prior art, and where its limits are.
---

# Why Mindlog

## The problem

An AI agent that works across sessions needs somewhere to keep what it learned: the user's preferences, decisions, facts about the world, how a task went last time. Usually this ends up split across systems: a memory service that extracts and searches, a vector database underneath it, a key-value store for state, and an application database for everything else. Each has its own durability story, and none of them knows what a *memory* is, so questions like these get answered in application code, if at all:

* Does a new fact contradict something the agent already believes?
* What did the agent know *last Tuesday*, before it was corrected?
* Can two agents work on the same memory without overwriting each other?
* When a source turns out to be wrong, can we remove everything derived from it?
* If a cached answer was built from a memory that has since been forgotten, is the answer gone too?

## The approach

Mindlog puts the memory engine **inside a replicated database**. Every `remember`, `forget`, conflict resolution, branch merge and cache entry is a command in a Raft log. Indexes, the knowledge graph and caches are deterministic projections of committed commands. That gives the memory features properties that are hard to bolt on from outside:

| Because… | …you get |
|---|---|
| Decisions are made at **commit time** on the leader and replicated | Conflict detection, trust classification and cache invalidation are atomic with the write, identical on every replica |
| Data is **never overwritten** (four timestamps, MVCC versions) | Exact point-in-time recall (`ASOF`) and world-time validity (`VALID_AT`) |
| Every record carries **provenance** | Quarantine of untrusted content, and a one-command taint cascade (`FORGET SOURCE`) |
| State is a **projection of the log** | Branches are cheap overlays at a fork version, and merges are planned, policy-driven commands |
| Models run **locally**, before proposing | Fully offline operation, and graceful degradation when models are down |

The same log also serves Redis clients and a PocketBase-style app backend, so one cluster can hold an application's data, its agents' memory, and its caches.

## Prior art

Each feature on its own has prior art. What Mindlog adds is the **combination inside one replicated, multi-agent database, with decisions made at commit time**.

| Feature | Prior art | What Mindlog adds |
|---|---|---|
| Conflict detection | Cognee, Graphiti | The check runs before commit with a local NLI model; the decision is replicated, follows a configurable policy with a review workflow, and also applies to branch merges |
| Memory branching | Letta Code, Dolt, Neon | Branches of individual memory scopes through Raft, with semantic plus CRDT merge for concurrent agents |
| Time travel | MVCC databases, Graphiti | `ASOF` (system time) and `VALID_AT` (world time) recall, both served from the log |
| Semantic cache | GPTCache, Redis LangCache | Invalidation driven by the memories an answer depends on, inside the same write |
| Agent memory over the Redis protocol | Redis Agent Memory Server, Agentis Memory | Raft durability and Multi-Raft scaling |

## Measured results

From the phase exit gates, on one Apple M-series laptop (full table: [SLOs](../slo.md)):

| | Result |
|---|---|
| Leader failover | median 1.53 s, max 1.85 s over 30 kills (target < 3 s) |
| Durability | no acknowledged write lost under kill -9, failover, Jepsen Maelstrom `lin-kv` with partitions, or the deterministic simulator |
| Recall quality, LongMemEval_s (100 questions) | recall_any@10: `hybrid_ppr` 0.94 vs `vector` 0.87 |
| Recall quality, LoCoMo (1,535 questions) | recall_any@10: `full` 0.712, `hybrid` 0.613, `vector` 0.525 |
| Recall latency at 10K memories | `hybrid_ppr` p95 43 ms with real models |
| Conflict detection | F1 0.92 (precision 0.87, recall 0.98) on 320 labelled pairs |
| Semantic cache | 1.4% false hits at similarity 0.92 |

## Known limits

Mindlog is honest about its shortcuts; each is recorded in an [architecture decision](../adr/README.md):

* The vector index is an **exact flat index** per scope (ADR-0008): deterministic and simple, but linear in scope size. HNSW is planned past ~100K memories per scope.
* Membership changes are **single-server**, not joint consensus (ADR-0006).
* Backups are **full** range snapshots; there is no point-in-time restore yet (ADR-0041).
* **Personalized PageRank** adds nothing measurable over hybrid retrieval with HippoRAG's untuned weights.
* **Cross-encoder rerank** in the default `full` recipe is the most accurate, but costs 0.4–1.4 s at p95. Latency-sensitive callers pass `recipe: hybrid`.
* **Semantic split** of very large scopes costs 4–7 points of recall@10.
