import { fromBinary } from '@bufbuild/protobuf';
import type { Clock, Logger, MindlogError, Metrics, Result } from '@mindlog/core';
import type { Job } from '@mindlog/proto';
import { JobSchema } from '@mindlog/proto';
import type { CommandStamper, Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { MvccReader } from '@mindlog/storage';
import { dueJobs, queueDepth } from './job-index.js';
import { jobKey } from './job-keys.js';

/** A job this node holds the lease of. */
export interface LeasedJob {
  readonly rangeId: bigint;
  readonly tenant: string;
  readonly user: string;
  readonly job: Job;
  /** The lease number; a completion must name it (ADR-0017). */
  readonly attempt: number;
}

/**
 * Runs one kind of job. Must be idempotent: a lease can expire mid-run and the
 * job run again. `completed: true` means the worker already completed the job
 * in its own command (e.g. a `MemoryCommit` with `complete`); `deferUntilMs`
 * runs it again then without counting the attempt (out of budget).
 */
export interface Worker {
  readonly kind: string;
  run(job: LeasedJob): Promise<Result<WorkerOutcome, MindlogError>>;
}

export interface WorkerOutcome {
  readonly completed: boolean;
  readonly deferUntilMs?: bigint;
}

export class WorkerRegistry {
  readonly #workers = new Map<string, Worker>();

  register(worker: Worker): void {
    if (this.#workers.has(worker.kind))
      throw new Error(`worker ${worker.kind} is already registered`);
    this.#workers.set(worker.kind, worker);
  }

  get(kind: string): Worker | undefined {
    return this.#workers.get(kind);
  }
}

export interface JobRunnerDeps {
  readonly rangeId: bigint;
  /** The node's whole state store. */
  readonly state: KvReader;
  readonly proposer: Proposer;
  readonly stamper: CommandStamper;
  /** Runs only while this returns true (the range leader). */
  readonly active: () => boolean;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly workers: WorkerRegistry;
  /** Lease length (default 60 s). */
  readonly leaseMs?: number;
  /** Jobs run at once per range (default 2). */
  readonly concurrency?: number;
}

const PRINCIPAL = 'system:jobs';

/**
 * Leader-only runner for one range (PLAN 12.7): finds due jobs in the range's
 * index, leases each through Raft, runs its worker and proposes the outcome.
 */
export class JobRunner {
  readonly #d: JobRunnerDeps;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<number> | undefined;

  constructor(deps: JobRunnerDeps) {
    this.#d = deps;
  }

  /** One pass; returns how many jobs it ran. */
  async runOnce(): Promise<number> {
    if (!this.#d.active()) return 0;
    const { state, rangeId, clock, metrics } = this.#d;
    metrics
      .gauge({
        name: 'mindlog_jobs_queue_depth_count',
        help: 'Queued and leased jobs per range (counted up to 10000)',
        labelNames: ['range'],
      })
      .set(await queueDepth(state, rangeId, 10_000), { range: String(rangeId) });
    const due = [];
    for await (const job of dueJobs(state, rangeId, clock.now(), this.#d.concurrency ?? 2))
      due.push(job);
    const ran = await Promise.all(due.map((j) => this.#runOne(j.tenant, j.user, j.id)));
    return ran.filter(Boolean).length;
  }

  async #runOne(tenant: string, user: string, id: string): Promise<boolean> {
    const { proposer, stamper, logger } = this.#d;
    const leased = await proposer.propose(
      stamper.stamp(tenant, PRINCIPAL, {
        case: 'jobLease',
        value: { user, id, leaseMs: BigInt(this.#d.leaseMs ?? 60_000) },
      }),
    );
    if (!leased.ok || leased.value.result.outcome.case !== 'job') return false; // another lease won
    const attempt = leased.value.result.outcome.value.attempt;
    const bytes = await new MvccReader(this.#d.state).get(jobKey(tenant, user, id));
    if (!bytes) return false;
    const job = fromBinary(JobSchema, bytes);
    const worker = this.#d.workers.get(job.kind);
    const started = this.#d.clock.monotonic();
    const result = worker
      ? await worker.run({ rangeId: this.#d.rangeId, tenant, user, job, attempt })
      : ({
          ok: false,
          error: { code: 'UNIMPLEMENTED', message: `no worker for ${job.kind}` },
        } as const);
    this.#d.metrics
      .histogram({
        name: 'mindlog_jobs_run_seconds',
        help: 'Time a worker took per job',
        labelNames: ['kind'],
      })
      .observe(Number(this.#d.clock.monotonic() - started) / 1e9, { kind: job.kind });
    if (result.ok && result.value.completed) return true;
    const error = result.ok ? '' : `${result.error.code}: ${result.error.message}`;
    if (error) logger.warn('job failed', { tenant, user, job: id, kind: job.kind, attempt, error });
    const deferUntilMs = result.ok ? (result.value.deferUntilMs ?? 0n) : 0n;
    const completed = await proposer.propose(
      stamper.stamp(tenant, PRINCIPAL, {
        case: 'jobComplete',
        value: { user, id, attempt, error, deferUntilMs },
      }),
    );
    if (!completed.ok)
      logger.warn('job completion not proposed', { job: id, error: completed.error.message });
    return true;
  }

  /** Runs every `intervalMs`, never overlapping. */
  start(intervalMs = 500): void {
    this.#timer ??= setInterval(() => {
      this.#running ??= this.runOnce()
        .catch((cause: unknown) => {
          this.#d.logger.warn('job runner pass failed', {
            error: cause instanceof Error ? cause.message : String(cause),
          });
          return 0;
        })
        .finally(() => {
          this.#running = undefined;
        });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }
}
