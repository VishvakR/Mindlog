# Building agent memory into a replicated database

*A design write-up of Mindlog v1: what it is, the trade-offs, and what was measured.*

## The idea

Agent memory stores and databases usually live apart. An agent writes memories through one service, and that service writes to a store that knows nothing about the memory semantics. Mindlog puts the memory engine inside the database's replicated log. Every remember, forget, conflict resolution, branch merge and cache entry is a command in a Raft log. Indexes, the knowledge graph and caches are deterministic projections of committed commands.

The same log also serves Redis clients over RESP and a PocketBase-style app backend. Prior art exists for each piece: conflict detection (Cognee, Graphiti), branching (Letta Code, Dolt, Neon), semantic caching (GPTCache), and Redis-protocol agent memory (Redis Agent Memory Server). What Mindlog tries is the combination inside one replicated, multi-agent database, with decisions made at commit time.

## Decisions that shaped it

**The log is the source of truth (ADR-0003).** Apply is deterministic: no clocks, randomness or model calls inside it. Model work happens on the leader before proposing, and its outputs (facts, embeddings, entities, NLI scores) are written into the command (ADR-0016).
- Followers never re-run models. Replicas agree by construction.
- The simulator can replay a whole cluster from a seed.
- Cost: commands are larger, and a model upgrade changes only new memories.

**Multi-Raft with a placement driver (ADR-0010, ADR-0028).** Ranges split and merge, and a PD group hands out ids and timestamps and schedules moves. A user's memory scope lives in one range (ADR-0031), so recall touches one range. Large scopes split semantically into sub-scopes (ADR-0039). That costs 4–7 points of recall@10 against one range, a documented gap.

**Conflicts at commit time (ADR-0015).** A new fact that an NLI model says contradicts an existing one is quarantined, not silently merged. A conflict record explains why. Facts are never overwritten: validity windows close instead, following Graphiti's four timestamps. A contradiction whose validity windows do not overlap is history, not a conflict.

**Branches as overlays (ADR-0013).** A branch reads main memory at its fork version plus its own keys, and merges through a planned command with a policy (`raise`, `prefer_branch`, `prefer_main`, `abort`). Fork points pin MVCC history from GC.

**Offline and degradable (ADR-0020).** The model sidecar is optional. Without it, memories are stored raw, enrichment jobs queue durably in the scope's range (ADR-0017), and recall falls back to keyword retrieval with `degraded: true`.

**Shortcuts taken on purpose.**
- An exact flat vector index instead of HNSW (ADR-0008): simpler and deterministic, linear in scope size.
- Single-server membership changes instead of joint consensus (ADR-0006).
- Full backups from range snapshots, without point-in-time restore (ADR-0041).

## What was measured

All numbers come from phase gates on one Apple M-series laptop. The full table, with the rows that were not measured, is in [`docs/slo.md`](../slo.md).

| | Result |
|---|---|
| Leader failover | median 1.53 s, max 1.85 s over 30 kills (target < 3 s) |
| Durability | no acknowledged write lost under kill -9, failover, Maelstrom `lin-kv` with partitions, or the deterministic simulator |
| KV on one node, fsync on | SET ~15.5K/s (p50 2.9 ms), GET ~38K/s (p50 1.2 ms), `redis-benchmark -c 50` |
| Recall at 10K memories | `hybrid_ppr` p95 43 ms with real models |
| LongMemEval_s, 100 questions | recall_any@10: `hybrid_ppr` 0.94 vs `vector` 0.87 |
| LoCoMo, 1,535 questions | recall_any@10: `full` 0.712, `hybrid` 0.613, `vector` 0.525 |
| Conflict detection | F1 0.92 (precision 0.87, recall 0.98) on 320 labelled pairs |
| Semantic cache | 1.4% false hits at similarity 0.92 |

## What did not work as hoped

- **Personalized PageRank** over the entity graph adds nothing measurable to recall over hybrid retrieval, with HippoRAG's untuned weights. It stays in a recipe, not the default path.
- **Cross-encoder rerank** is the most accurate recipe, but it costs 0.4–1.4 s at p95. It is excluded from the latency target.
- **Semantic split** loses some recall to fusion across clusters; fanning out to more clusters did not recover it.

## What is next

HNSW for scopes past ~100K memories, incremental backups with point-in-time restore, a measured 3-node latency suite, and PPR weights fitted on the eval harness.
