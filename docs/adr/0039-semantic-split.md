# ADR-0039: Semantic split of large memory scopes

- Status: accepted
- Date: 2026-11-11
- PLAN: 8.5 (semantic split; amended), 12, 24 phase 10
- References: [ADR-0031](0031-memory-key-layout-and-scope-placement.md), [ADR-0016](0016-model-calls-before-proposing.md), [ADR-0033](0033-memory-lifecycle.md)

## Context

A user's memory lives in one range (ADR-0031), so recall is single-range, but a scope that outgrows a range cannot split by size: every key starts with the same user. PLAN 8.5 asks for k-means (k = 2) over the scope's embeddings, a cluster component in the key, centroids in the range descriptor, recall routed to the two nearest clusters, re-clustering on drift, and background re-homing.

## Decision

- **A cluster is a scope.** Cluster 0 is the scope itself; cluster n is the user `user␀c<n>`. Memory schemas refuse control characters, so no client can name one, and the NUL makes each cluster its own split boundary. The split chooser, unsplit scopes and every key format are unchanged, so nothing migrates; below the service a cluster is just another user.
- **The layout** (each cluster's centroid and spread) lives in the root scope's lifecycle row, not in the range descriptor: PD has no embeddings, and the layout must be read where the root's leader routes writes.
- **Writes**: the root's leader embeds the text once (`route`) and the remember goes to the nearest cluster's leader as a normal remember, so a commit stays atomic in one range. A derived memory goes to the cluster of its least trusted parent, so trust is still inherited at commit time. Without embeddings the root takes the write.
- **Recall** embeds the query once, asks the nearest `memory.split.recallClusters` clusters (two by default; all of them when degraded) and fuses their rankings by RRF, then packs again within the budget. Every other operation addresses all clusters and merges: lists and conflict pages use `c<cluster>:<cursor>` cursors, get and resolve take the first cluster that has the id, writes by id sum, a taint cascade follows derived memories across clusters to a fixpoint, exports merge the clusters' cube parts, and `ASOF index` becomes a time on the root, since indexes are per range.
- **The split job** (`memory.split`) is enqueued by a scope's tick when it holds `memory.split.maxMemories` hot memories (default 100,000), and hourly on split scopes for drift. It runs on the cluster's leader: k-means (seeded per scope, on a worker thread), a new layout on the root, then moves. A drift past `driftRatio` (1.5) times the stored spread re-centres the cluster. At most 8 clusters.
- **A move** is `MemoryRehome` (body 103) twice: the target takes the copies with their original stamps (`createdAt`, `logIndex`), then the source marks them `movedTo` and unindexes them, keeping the record and its versions for history. Readers treat a moved record as absent. Both steps are idempotent, so an interrupted batch runs again; between them a memory is briefly in two clusters, and fan-out reads show it once. Moves raise no change events.
- Proposing it waits for cluster version 10.

## Alternatives considered

- **A cluster component after the user in every key** (PLAN 8.5 as written): every memory key and the split chooser change, and unsplit scopes would need a migration.
- **Moving with the normal remember and forget**: resets creation stamps, so ASOF and recency change, and emits added/forgotten events that make embedded replicas drop the id.

## Consequences

- Conflict detection, the entity graph and PPR are per cluster: a contradiction or relation across clusters is not seen.
- `MEM.BRANCH` and the semantic cache are refused on a split scope.
- A moved memory's record stays in its old cluster (unindexed), so the old range shrinks only by its indexes, not its records.
- Every request first reads the scope's layout (cached for two seconds per node); on a cluster this is one forwarded call per scope per two seconds.
- An unsplit scope is untouched by all of this.
- Measured on LongMemEval (100 questions, scopes forced to split at 100 memories, `docs/phases/phase-10.md`): turn recall@10 drops 4–7 points against one range (hybrid + PPR 93 → 89, hybrid 94 → 88, vector 92 → 85). Searching three clusters instead of two does not close it, which points at rank fusion across clusters and per-cluster statistics rather than routing.
