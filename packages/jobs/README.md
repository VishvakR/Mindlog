# @mindlog/jobs

Durable jobs stored in the scope's range (PLAN 12.7, ADR-0017).

## Public API

- **Apply**:
  - `enqueueJob(ctx, user, spec)` adds a job inside another command's apply, for example a `MemoryCommit`;
  - `completeJob(ctx, user, {id, attempt}, error?, deferUntilMs?)` finishes lease `attempt`: done, requeued with backoff, dead, or deferred (requeued for later without counting the attempt, for a worker out of budget);
  - `jobLeaseHandler` (body 71) and `jobCompleteHandler` (body 72);
  - `jobRangeHooks` moves the due index on split and merge.
- **Reads**: `dueJobs(state, rangeId, nowMs, limit)` and `queueDepth(state, rangeId, limit)`. Key helpers are `jobKey`, `jobIndexKey` and `jobIndexPrefix`.
- **Running**: `JobRunner` is leader-only and per range. It leases due jobs (the lease is a replicated command), runs the `Worker` registered for the job's kind in a `WorkerRegistry`, and proposes `JobComplete`. A worker that completes the job inside its own command returns `{ completed: true }`; one that returns `deferUntilMs` is requeued for then.

## Invariants

- The job record is `m/(user, 'j', id)` (MVCC, in the user's range). The due index is `rangeLocalKey(range, 'jobs', atMs, tenant, user, id)`, where `atMs` is the run time while the job is queued and the lease end while it is leased.
- `attempts` is the lease epoch. Only the current lease can complete a job, so a holder that lost its lease after a leader change cannot finish it.
- Retries back off by 2^attempt seconds. After `MAX_ATTEMPTS` (5) failed leases (deferrals not counted) the job is `dead`, and it is kept for the dashboard. Done jobs are deleted.
- Workers must be idempotent, because an expired lease can run a job twice. Only one completion applies.

## Metrics

- `mindlog_jobs_queue_depth_count{range}` (gauge)
- `mindlog_jobs_run_seconds{kind}` (histogram)
