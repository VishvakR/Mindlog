# ADR-0033: Memory lifecycle: consolidation, forgetting and the cold tier

- Status: accepted
- Date: 2026-11-01
- PLAN: 12.6 (consolidation workers), 12.4 stage 10 (RecordRecall), 13.7 (forgetting curve), 10.4 (tiered storage), 13.11 (memory cubes), 6.1 (commands 21, 23), 19.5 (cluster version)
- References: letta.md, a-mem.md, memorybank.md, cognee.md, leiden.md

## Context

Phase 8 has background workers improve memory: sleep-time consolidation, evolution, dedup, themes and entity summaries. Memory also has to forget: recalls strengthen a memory, unused ones fade, and faded ones move to a blob store. Every change has to be a replicated command (CLAUDE.md rules 1, 2, 8). Workers run on the scope's leader, so they must resume after a leader change. Followers cannot read a blob store, run a model or read a clock during apply.

Before this phase, jobs were only enqueued inside a `MemoryCommit`. `strength`, `recall_count` and `last_recalled_at` existed on the record but nothing ever wrote them.

## Decision

**Commands (cluster version 8, `BINARY_VERSION = 8`)**
- `MemoryMaintain = 21`: one user scope's lifecycle changes in one batch. These are evolve (a new version, the old one kept at `m/(user,'rv',id,version)`), tier moves, entity summaries, re-embedded vectors, pins, jobs to enqueue, the completion of the worker's own job, a checkpoint `(worker, cursor)` and the scope's next tick.
  - One body replaces the separate `MemoryEvolve`, `TierChange` and `EntityUpdate` that PLAN 12.6 names. Every worker needs the same completion, checkpoint and enqueue fields, and there is then one case to add to the change feed, the vector cache and the simulator.
- `MemoryRecallStats = 23`: memories a recall returned. Apply sets `S ← S × (1 + 0.5 × min(1, t/S))` with t in days since the last recall (PLAN 13.7) from the command's HLC, increments `recall_count` and sets `last_recalled_at`.
  - The engine batches ids per scope for 2 s. It never sends them for branch or `ASOF` reads.
- Both are main-only. On a branch they are `INVALID_ARGUMENT`; sleep-time branches carry only `MemoryCommit`s.
- `JobComplete.defer_until_ms`: a worker out of budget requeues its job without the lease counting toward dead (`Job.deferrals`).
- New memories start at `S₀ = 1 + 9 × importance` days, as PLAN 13.7 says. Phase 5 used `1 + 4×`.

**Scheduling: a self-rescheduling tick job per scope**
- `ScopeLifecycle` at `m/(user,'cs')` is kept by apply. It holds:
  - hot and cold counts;
  - memories since the last sleep and the last evolve;
  - graph size, and the graph size when themes were last built;
  - the scope's embedding model and whether vectors of another model remain;
  - when each worker kind was last enqueued;
  - checkpoints;
  - the scheduled tick.
- A main `MemoryCommit` carries a `tick` job spec chosen by the leader. Apply enqueues it only if no tick is scheduled, so a scope has at most one.
- The tick worker reads the state and the clock (on the leader) and decides which workers are due with a pure function. It proposes one `MemoryMaintain` that:
  - enqueues them, with ids `<kind>-<ms>`;
  - completes the tick;
  - schedules the next tick when work remains (memories are hot, or a cache exists), and otherwise lets ticking stop until the next write.
  - When apply enqueues a worker kind, it resets that kind's trigger (sleep and evolve counts, the theme graph mark).
- This reuses the durable job queue's leases, backoff, range-local index and split handling. There is no new scheduler loop or range-local scope index.
  - The cost is that the cadence is the tick interval (`memory.consolidation.tickMs`, default 15 min). The CacheJanitor therefore runs at most once per tick, not every 5 min as PLAN 12.6 says.
- The per-tenant model-seconds budget is a node-local token bucket (`shortcut:`). A leader change resets it, and a worker over budget defers its job.

**Cold tier**
- The ForgettingWorker takes memories whose retention `e^(−t/S)` is below `memory.forgetting.coldBelow` (0.2) and are not pinned.
  - It first writes a gzip JSON segment of their full records and vectors to the default `BlobStore`, keyed by its sha256 (`cold/<tenant>/<user>/<sha256>.json.gz`). The put is durable before anything is proposed.
  - Only then does it propose the tier moves with segment key, sha256 and stub text.
- Apply turns each record into a stub: the text becomes a summary (the first sentence, at most 160 characters), the tier becomes `cold`, and the vector row and the in-memory index entry go away.
  - Postings, entity mentions and links stay, so keyword, entity and graph retrieval and explicit lookups still find it (PLAN 10.4).
  - Followers never touch the blob store.
- `INCLUDE_COLD` lets recall return cold stubs. The leader loads the full record from the segment for the result. Recalling a cold memory proposes a move back to hot, with the text and vector from the segment, or a fresh vector when the model changed.
- With hard forgetting enabled for a tenant (`hardForgetTenants`, default none), memories with retention below `deleteBelow` (0.02), importance below 0.2 and no links from hot memories are forgotten through the audited `MemoryForget`, reason `forgetting curve`.
- Blob stores are a port in `@mindlog/blob`:
  - the local disk store writes, fsyncs and renames;
  - the S3 store targets MinIO, with our own SigV4 over `fetch` rather than the AWS SDK and its dependency tree;
  - there is an in-memory fake;
  - one contract suite runs against all three.
- Segments of memories that came back hot are not deleted (`shortcut:`, collect them once segment GC exists).

**Other workers**
- **Sleep-time:**
  - It works on a branch named `sleep-<ms>`; the branch-name rule has no `/`, and this keeps the wire format.
  - It summarizes recent episodic memories per session into `semantic` memories with `derived_from` links and `source.type = consolidation`.
  - It plans the merge under policy `raise`. If the plan has more than `maxConflicts` contradictions it drops the branch; otherwise it merges.
  - The branch is dropped in a `finally`, because an open branch pins GC.
- **Evolution (A-MEM):** for a new memory with `related` links, it rewrites the linked older memories' tags and `meta.context`, from the Summarizer when available and from entity names otherwise.
- **Dedup:** pairs with cosine ≥ 0.93. The newer memory gets half its importance, a `duplicate` tag and `meta.duplicateOf`; the older one gets a `supersedes` link. Nothing is deleted.
- **Themes:**
  - They run when the graph has grown by more than 5% since the last build.
  - They use Louvain communities over the entity graph (deterministic node order; Leiden's refinement is not built), in `@mindlog/index-graph`.
  - Each community becomes a `theme` memory linked to its members, and the old theme memories are superseded.
  - The per-query theme retriever stays as a fallback.
- **Entity summaries:** written when an entity's mention count reaches 5 and later doubles since its last summary.
- **Re-embedding and index generations:**
  - The vector cache indexes only vectors of the scope's current embedding model. A commit with a new model switches the scope and marks it for re-embedding.
  - The ReembedWorker replaces the other vectors in checkpointed batches and clears the mark when none remain. Until then the vector retriever sees only re-embedded and new memories, and the other retrievers see everything.
- **Summaries:** a new `Summarizer` port. The Python service answers with centroid sentence selection over the MiniLM embeddings, or with the GGUF model when `EXTRACT_GGUF` is set. Texts are quoted data, and the instruction is Mindlog's own.

**A change to ADR-0013's merge rule**
- The phase 8 simulator found that a write to a branch made after its merge was planned is lost: the plan names the branch memories it read, and apply only checked that main had not moved. `BranchMerge.branch_generation` (field 11) now carries the branch's generation too. Apply refuses a stale plan with `CONFLICT`, and the leader plans again.
- The field is set only from cluster version 8, so every replica that sees it checks it.

## Alternatives considered

- **A scheduler loop per range scanning scope states** (like `ExpiryJob`): it needs a range-local index of scopes, moved on split and merge. The tick job gets that for free from the job queue.
- **Separate commands per worker**, as named in PLAN: they duplicate completion, checkpoint and enqueue handling 5 times.
- **Moving cold records wholly to the blob store**: graph walks, keyword search and `MEM.GET` would then need a blob read on every hit.
- **Re-embedding into a parallel vector space and swapping it atomically**: the swap is one command over every vector of a scope, and queries are already embedded with the new model, so old vectors are useless for vector search either way.
- **`@aws-sdk/client-s3`**: complete, but about 100 packages for four calls.

## Consequences

- Recalls write records, so the MVCC version count of each record grows with use. The record history view uses the evolve versions (`rv` rows) rather than raw MVCC versions.
- Cold stubs keep their BM25 postings. The keyword index does not shrink when memory goes cold; vectors, the bulk of a record, do.
- A scope ticks every 15 min while it has hot memories, which is two commands per tick (lease and maintain).
- A node-local budget can be exceeded by up to one hour's allowance after a leader change.
- To watch:
  - `mindlog_consolidation_runs_total{worker,outcome}`;
  - `mindlog_consolidation_model_seconds_total{tenant}`;
  - `mindlog_memory_tier_moves_total{tier}`;
  - the scope's hot and cold counts on the Jobs page.
