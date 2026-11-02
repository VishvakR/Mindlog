# @mindlog/consolidation

Background workers that improve and forget memory (PLAN 12.6, 13.7; ADR-0033). They run as durable jobs in the scope's range (`@mindlog/jobs`) on its leader and write through the normal command path.

## Public API

- **`consolidationWorkers(deps)`**: the workers to register with the job runner:
  - `consolidation.tick`: the scheduler. It reads the scope's lifecycle state, decides what is due with `planTick`, and in one `MemoryMaintain` enqueues those workers, completes itself and schedules the next tick (every `tickMs` while the scope has hot memories or a cache).
  - `consolidation.sleep` (Letta-style sleep-time): distils recent episodic sessions into `semantic` memories with `derived_from` links on a branch `sleep-<ms>`, then merges it under policy `raise`, or drops it when the plan has more than `maxConflicts` contradictions. The branch never stays open.
  - `consolidation.evolve` (A-MEM): older memories linked `related` to new ones get their entities as tags and a refreshed `meta.context` from the Summarizer.
  - `consolidation.dedup`: a memory with cosine ≥ 0.93 to an older one gets half the importance, a `duplicate` tag and `meta.duplicateOf`; the older one a `supersedes` link. Nothing is deleted.
  - `consolidation.themes`: Louvain communities of the entity graph become `theme` memories linked to their members; previous themes are forgotten.
  - `consolidation.entities`: summaries of entities whose mention count reached 5 and later doubled.
  - `consolidation.forget`: memories with retention below `coldBelow` (0.2), not pinned, go to the cold tier (segment first, then the tier move); with hard forgetting on for the tenant, faded unimportant ones nothing hot links to are forgotten with reason `forgetting curve`.
  - `consolidation.reembed`: re-embeds vectors of another model than the scope's, in checkpointed batches.
  - `consolidation.cache`: drops expired semantic-cache entries.
- **`planTick(state, nowMs, config, facts)`**: the pure schedule, with a reason per worker (shown on the Jobs page).
- **`ModelBudget`**: model time per tenant per hour (node-local token bucket). A worker without budget defers its job instead of failing it.

## Invariants

- Workers are idempotent per attempt: request ids are `<kind>:<job>:<attempt>:<n>`, and apply skips changes to memories forgotten meanwhile.
- Long workers checkpoint in their own commands (`checkpointWorker`, `checkpoint`), so a new leader resumes them.
- Models are called only here, before proposing; summaries treat memory text as quoted data.

## Metrics

- `mindlog_consolidation_runs_total{worker,outcome}` (done, deferred, error)
- `mindlog_consolidation_run_seconds{worker}`
- `mindlog_consolidation_model_seconds_total{tenant}`
- `mindlog_consolidation_sleep_merges_total{outcome}` (merged, rejected)
- `mindlog_memory_tier_moves_total{tier}`
- Spans `consolidation.<worker>`.
