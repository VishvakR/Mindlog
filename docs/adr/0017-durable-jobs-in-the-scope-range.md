# ADR-0017: Durable jobs stored in the scope's range

- Status: accepted
- Date: 2026-10-18
- PLAN: 12.2 (async mode), 12.7, CLAUDE.md rule 8
- References: redis-agent-memory.md, letta.md

## Context

Enrichment after a fast or degraded `remember` must survive crashes and leader changes, run once per job, and move with the data when ranges split. Leasing must be a replicated decision (CLAUDE.md rule 8).

## Decision

- A job is an MVCC record `m/(user, 'j', jobId)` = `Job {id, kind, payload, state, attempts, runAtMs, leaseUntilMs, error}` in the user's range (ADR-0031). States: `queued → leased → done | (failed → queued) | dead`.
- Due work is found through a range-local raw index `rangeLocalKey(rangeId, 'jobs', atMs, tenant, user, jobId)`, where `atMs` is the run time (queued) or the lease end (leased). Range hooks move it on split and merge, like the expiry index.
- `JobLease {user, id, leaseMs}` is proposed only by the range leader's `JobRunner`; apply accepts it when the job is queued and due, or leased past its lease end, and increments `attempts`. The attempt number is the lease epoch.
- `JobComplete {user, id, attempt, done | error}` is applied only if `attempt` matches, so a stale holder after a leader change cannot finish a job it lost. An error requeues with backoff `2^attempt s` until 5 attempts, then `dead` (kept for the dashboard).
- A `MemoryCommit` can enqueue jobs and complete one in the same batch, so enrichment output and job completion are atomic.
- Backpressure: `remember(async)` returns `BUSY` when the user scope already holds `maxQueuedJobs` (default 1,000) queued or leased jobs, counted from its `m/(user, 'j')` records in the same range; dead jobs do not count. A synchronous remember needs no job and is not refused.

## Alternatives considered

- **An external queue** (Redis Streams, Docket): another system to run, not replicated with the data.
- **Leader-local in-memory queues**: lost on crash.

## Consequences

- Workers must be idempotent; a job may run more than once when a lease expires mid-run, but only one completion applies.
- Metrics: `mindlog_jobs_queue_depth_count`, `mindlog_jobs_run_seconds`, `mindlog_jobs_dead_total`.
