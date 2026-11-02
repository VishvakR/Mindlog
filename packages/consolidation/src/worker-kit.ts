import type { BlobStore } from '@mindlog/blob';
import type { Clock, Logger, Metrics, MindlogError, Result, Tracer } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { LeasedJob, Worker, WorkerOutcome } from '@mindlog/jobs';
import type { CallContext, MemoryEngine, MemoryRange, MemoryScope } from '@mindlog/memory';
import { MemoryReads } from '@mindlog/memory';
import type { MessageInitShape } from '@bufbuild/protobuf';
import type { Models } from '@mindlog/models-client';
import type { MemoryMaintainSchema } from '@mindlog/proto';
import type { ModelBudget } from './budget.js';
import type { ConsolidationConfig } from './config.js';

export interface ConsolidationDeps {
  readonly engine: MemoryEngine;
  readonly models: Models;
  /** This node's replica of a range. */
  readonly ranges: (rangeId: bigint) => MemoryRange | undefined;
  readonly clock: Clock;
  readonly ids: { next(): string };
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly budget: ModelBudget;
  readonly config: ConsolidationConfig;
  /** The cold tier's blob store; without it nothing goes cold. */
  readonly cold?: BlobStore;
}

/** One run of a worker on one scope's job. */
export interface Run {
  readonly job: LeasedJob;
  readonly range: MemoryRange;
  readonly scope: MemoryScope;
  readonly reads: MemoryReads;
  readonly nowMs: bigint;
  /** A call context whose request id is this attempt's n-th proposal (idempotent retries). */
  context(n: number | string): CallContext;
  /** Proposes a `MemoryMaintain` with the n-th request id. */
  maintain(
    n: number | string,
    body: MessageInitShape<typeof MemoryMaintainSchema>,
  ): Promise<Result<{ ids: string[]; count: number }, MindlogError>>;
  /** Completes this job with a checkpoint (the worker's last command). */
  finish(checkpoint?: string): Promise<Result<WorkerOutcome, MindlogError>>;
  /** Runs a model call against the tenant's budget; `undefined` once the budget is spent. */
  model<T>(
    call: () => Promise<Result<T, MindlogError>>,
  ): Promise<Result<T, MindlogError> | undefined>;
}

const encoder = new TextEncoder();

/** Defers a job until the tenant's budget refills (ADR-0033). */
export function deferred(d: ConsolidationDeps, run: Run): Result<WorkerOutcome, MindlogError> {
  const wait = Math.max(60_000, d.budget.waitMs(run.scope.tenant));
  return ok({ completed: false, deferUntilMs: run.nowMs + BigInt(wait) });
}

/**
 * A consolidation `Worker` (PLAN 12.6): finds the job's range, runs `body` in
 * a span and counts the outcome in `mindlog_consolidation_runs_total`.
 */
export function worker(
  kind: string,
  d: ConsolidationDeps,
  body: (run: Run) => Promise<Result<WorkerOutcome, MindlogError>>,
): Worker {
  const runs = d.metrics.counter({
    name: 'mindlog_consolidation_runs_total',
    help: 'Consolidation worker runs by outcome',
    labelNames: ['worker', 'outcome'],
  });
  const seconds = d.metrics.histogram({
    name: 'mindlog_consolidation_run_seconds',
    help: 'Time a consolidation worker took per job',
    labelNames: ['worker'],
  });
  const modelMs = d.metrics.counter({
    name: 'mindlog_consolidation_model_seconds_total',
    help: 'Model time used by consolidation workers',
    labelNames: ['tenant'],
  });
  return {
    kind,
    run: (job) =>
      d.tracer.withSpan(
        `consolidation.${kind.replace('consolidation.', '')}`,
        { 'mindlog.tenant': job.tenant, 'mindlog.range': String(job.rangeId) },
        async () => {
          const range = d.ranges(job.rangeId);
          if (!range)
            return err(mindlogError('UNAVAILABLE', `range ${String(job.rangeId)} is not here`));
          const scope = { tenant: job.tenant, user: job.user };
          const context = (n: number | string): CallContext => ({
            principal: 'system:consolidation',
            requestId: encoder.encode(`${kind}:${job.job.id}:${String(job.attempt)}:${String(n)}`),
          });
          const run: Run = {
            job,
            range,
            scope,
            reads: new MemoryReads(range.reader, job.tenant, job.user),
            nowMs: d.clock.now(),
            context,
            maintain: (n, b) => d.engine.maintain(range, scope, b, context(n)),
            async finish(checkpoint) {
              const done = await d.engine.maintain(
                range,
                scope,
                {
                  complete: { id: job.job.id, attempt: job.attempt },
                  ...(checkpoint !== undefined ? { checkpointWorker: kind, checkpoint } : {}),
                },
                context('done'),
              );
              return done.ok ? ok({ completed: true }) : done;
            },
            async model(call) {
              if (!d.budget.available(job.tenant)) return undefined;
              const started = d.clock.monotonic();
              const r = await call();
              const ms = Number(d.clock.monotonic() - started) / 1e6;
              // A call is never free, even when the clock says so (tests, coarse timers).
              d.budget.spend(job.tenant, Math.max(1, ms));
              modelMs.inc(ms / 1000, { tenant: job.tenant });
              return r;
            },
          };
          const started = d.clock.monotonic();
          const out = await body(run);
          seconds.observe(Number(d.clock.monotonic() - started) / 1e9, { worker: kind });
          const outcome = !out.ok ? 'error' : out.value.deferUntilMs ? 'deferred' : 'done';
          runs.inc(1, { worker: kind, outcome });
          if (!out.ok)
            d.logger.warn('consolidation worker failed', {
              worker: kind,
              tenant: job.tenant,
              rangeId: String(job.rangeId),
              error: out.error.message,
            });
          return out;
        },
      ),
  };
}
