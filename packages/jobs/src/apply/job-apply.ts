import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { CommandResult, Job, JobRef, JobSpec } from '@mindlog/proto';
import { CommandResultSchema, JobSchema, JobState } from '@mindlog/proto';
import type { ApplyContext, ApplyHandler } from '@mindlog/statemachine';
import { errorResult, inSpan } from '@mindlog/statemachine';
import { jobIndexKey, jobKey } from '../job-keys.js';

/** Leases granted before a job is dead (PLAN 12.7). */
export const MAX_ATTEMPTS = 5;

/** Seconds before retry n: 2^n. */
const backoffMs = (attempt: number): bigint => 1000n * 2n ** BigInt(attempt);

function inRange(ctx: ApplyContext, user: string, id: string): CommandResult | undefined {
  return inSpan(ctx.descriptor, jobKey(ctx.command.tenant, user, id))
    ? undefined
    : errorResult('RANGE_MOVED', `job is not in range ${String(ctx.descriptor.rangeId)}`);
}

/** When the index finds the job next: its lease end while leased, else its run time. */
const dueAt = (job: Job): bigint =>
  job.state === JobState.LEASED ? job.leaseUntilMs : job.runAtMs;

async function load(ctx: ApplyContext, user: string, id: string): Promise<Job | undefined> {
  const bytes = await ctx.txn.get(jobKey(ctx.command.tenant, user, id));
  return bytes ? fromBinary(JobSchema, bytes) : undefined;
}

/** Writes the job and moves its index entry from `before` (if indexed) to its new due time. */
function store(ctx: ApplyContext, user: string, job: Job, before: bigint | undefined): void {
  const { tenant } = ctx.command;
  const rangeId = ctx.descriptor.rangeId;
  if (before !== undefined) ctx.raw.batch.del(jobIndexKey(rangeId, before, tenant, user, job.id));
  if (job.state === JobState.DONE) {
    ctx.txn.delete(jobKey(tenant, user, job.id));
    return;
  }
  ctx.txn.put(jobKey(tenant, user, job.id), toBinary(JobSchema, job));
  if (job.state === JobState.QUEUED || job.state === JobState.LEASED)
    ctx.raw.batch.put(jobIndexKey(rangeId, dueAt(job), tenant, user, job.id), new Uint8Array());
}

function outcome(job: Job): CommandResult {
  return create(CommandResultSchema, {
    outcome: { case: 'job', value: { attempt: job.attempts, state: job.state } },
  });
}

/**
 * Enqueues a job inside another command's apply (a `MemoryCommit`), in the
 * same atomic batch. Returns an error result when the job is outside the range.
 */
export function enqueueJob(
  ctx: ApplyContext,
  user: string,
  spec: JobSpec,
): CommandResult | undefined {
  const moved = inRange(ctx, user, spec.id);
  if (moved) return moved;
  const job = create(JobSchema, {
    id: spec.id,
    kind: spec.kind,
    payload: spec.payload,
    state: JobState.QUEUED,
    runAtMs: spec.runAtMs === 0n ? ctx.nowMs : spec.runAtMs,
    createdAt: ctx.version,
  });
  store(ctx, user, job, undefined);
  return undefined;
}

/**
 * Finishes lease `ref.attempt` of a job: done when `error` is empty, otherwise
 * requeued with backoff, or dead after `MAX_ATTEMPTS`. With `deferUntilMs` and
 * no error it is requeued for then, and that lease does not count toward dead
 * (a worker out of budget, ADR-0033). A stale attempt (the lease expired and
 * was granted again) is a `CONFLICT` and changes nothing. Returns the job
 * outcome, or the error result (check `outcome.case`).
 */
export async function completeJob(
  ctx: ApplyContext,
  user: string,
  ref: Pick<JobRef, 'id' | 'attempt'>,
  error = '',
  deferUntilMs = 0n,
): Promise<CommandResult> {
  const moved = inRange(ctx, user, ref.id);
  if (moved) return moved;
  const job = await load(ctx, user, ref.id);
  if (!job) return errorResult('NOT_FOUND', `no job ${ref.id}`);
  if (job.state !== JobState.LEASED || job.attempts !== ref.attempt)
    return errorResult('CONFLICT', `lease ${String(ref.attempt)} of job ${ref.id} is not current`);
  const before = dueAt(job);
  if (error === '' && deferUntilMs > 0n) {
    job.state = JobState.QUEUED;
    job.deferrals++;
    job.runAtMs = deferUntilMs;
  } else if (error === '') job.state = JobState.DONE;
  else {
    job.error = error;
    if (job.attempts - job.deferrals >= MAX_ATTEMPTS) job.state = JobState.DEAD;
    else {
      job.state = JobState.QUEUED;
      job.runAtMs = ctx.nowMs + backoffMs(job.attempts);
    }
  }
  store(ctx, user, job, before);
  return outcome(job);
}

/** `JobLease`: grants the next lease of a due job, or of one whose lease ran out. */
export const jobLeaseHandler: ApplyHandler = {
  body: 'jobLease',
  async apply(ctx) {
    if (ctx.command.body.case !== 'jobLease') throw new Error('jobLease handler got another body');
    const { user, id, leaseMs } = ctx.command.body.value;
    const moved = inRange(ctx, user, id);
    if (moved) return moved;
    const job = await load(ctx, user, id);
    if (!job) return errorResult('NOT_FOUND', `no job ${id}`);
    const due =
      (job.state === JobState.QUEUED && job.runAtMs <= ctx.nowMs) ||
      (job.state === JobState.LEASED && job.leaseUntilMs <= ctx.nowMs);
    if (!due) return errorResult('CONFLICT', `job ${id} is not due or is leased`);
    const before = dueAt(job);
    job.state = JobState.LEASED;
    job.attempts++;
    job.leaseUntilMs = ctx.nowMs + leaseMs;
    store(ctx, user, job, before);
    return outcome(job);
  },
};

/** `JobComplete`: see `completeJob`. */
export const jobCompleteHandler: ApplyHandler = {
  body: 'jobComplete',
  async apply(ctx) {
    if (ctx.command.body.case !== 'jobComplete')
      throw new Error('jobComplete handler got another body');
    const { user, id, attempt, error, deferUntilMs } = ctx.command.body.value;
    return completeJob(ctx, user, { id, attempt }, error, deferUntilMs);
  },
};
