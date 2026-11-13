# Service level objectives: measured

PLAN §1.5 set these targets for a 3-node cluster on one laptop. This page gives what was measured, where, and the rows not measured in v1 with the reason. The v1 release has no separate benchmark run (the user's choice), so every number comes from a phase gate. Hardware: an Apple M-series laptop; Docker for multi-node runs.

| SLO | Target | Measured | Status | Evidence |
|---|---|---|---|---|
| Write availability | Writes succeed with ≥ 2 of 3 replicas up | Writes continue after the leader is killed; Maelstrom `lin-kv` is valid under partitions | met | [phase-3](phases/phase-3.md), `test/integration/failover.test.ts`, nightly Maelstrom |
| Leader failover | < 3 s to a new leader serving writes | median 1.53 s, p90 1.75 s, max 1.85 s over 30 kills | met | [phase-3](phases/phase-3.md) |
| KV write latency (p99, no model) | < 15 ms | Single node with fsync, `redis-benchmark -c 50`: SET p50 2.9 ms; 3 nodes in Docker: 700–950 writes/s | p99 not measured | [phase-1](phases/phase-1.md), [phase-3](phases/phase-3.md) |
| KV read latency (p99, lease read) | < 3 ms | GET p50 1.2 ms on one node; the lease check costs ~13% throughput | p99 not measured | [phase-1](phases/phase-1.md), [phase-3](phases/phase-3.md) |
| Recall latency (p95, 100K memories, no rerank) | < 150 ms | At 10K memories: `hybrid_ppr` p95 43 ms with real models, 140 ms under eval load; routed split recall p95 ≤ 104 ms | measured at 10K only | [phase-5](phases/phase-5.md), [phase-6](phases/phase-6.md), [phase-7](phases/phase-7.md), [phase-10](phases/phase-10.md) |
| Memory write latency (p95, with extraction) | < 2 s; `ASYNC` ack < 20 ms | Not measured as a percentile; the async and degraded paths acknowledge before enrichment | not measured | `test/integration/degraded.test.ts` |
| Durability | Zero acknowledged-write loss | No loss in kill -9 under load, 30 failover kills, Maelstrom, or simulator runs | met | `pnpm test:durability`, [phase-3](phases/phase-3.md), [phase-4](phases/phase-4.md) |
| Recall quality | LongMemEval and LoCoMo published | LongMemEval_s (100 q): `hybrid_ppr` recall_any@10 0.94 vs `vector` 0.87; LoCoMo (1,535 q): `full` 0.712, `hybrid` 0.613, `vector` 0.525 | published | [phase-6](phases/phase-6.md), [`docs/evals/`](evals/) |

## Why some rows are not measured

- **p99 KV latency on 3 nodes and the memory-write percentiles** need a dedicated load run (memtier, a recall load generator), which was left out of v1.
- **Recall at 100K memories.** The vector index is an exact flat scan (ADR-0008, shortcut noted in `FlatIndex`), so latency grows linearly with scope size. 100K is expected to need HNSW or a semantic split (ADR-0039) to stay under 150 ms.
- **The `full` recipe** (cross-encoder rerank) is excluded from the 150 ms target by definition. It costs p95 0.37–1.4 s depending on text length.

## Capacity worksheet (PLAN 20.3)

| Input | Measure |
|---|---|
| Bytes per memory record | ~1.5 KB of vector (384 floats) plus text and metadata; not measured per record |
| HNSW RAM per 100K vectors | n/a: v1 uses the flat index (~150 MB of float32 per 100K vectors) |
| Recall p95 at 10K / 100K / 1M | 43 ms / not measured / not measured |
| Writes/s per range at p99 < 15 ms | ~15K SET/s on one node (p50); 700–950/s on 3 nodes in Docker |
| Extraction throughput per core | not measured |
