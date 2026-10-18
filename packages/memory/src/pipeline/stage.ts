import type { Clock, MindlogError, Metrics, Result, Tracer } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Capability } from '@mindlog/models-client';

/** How a stage failed (PLAN 12.2). */
export interface StageError {
  readonly kind: 'retryable' | 'skippable' | 'fatal';
  readonly error: MindlogError;
}

/**
 * One step of a pipeline. Stages share one draft type: each returns the draft
 * with its part filled in. A stage with a `fallback` can be skipped when its
 * model is unavailable or it fails or times out; the run is then degraded.
 */
export interface Stage<D> {
  readonly name: string;
  /** The model capability it calls, if any. */
  readonly needs?: Capability;
  readonly timeoutMs?: number;
  run(draft: D, context: StageRunContext): Promise<Result<D, StageError>>;
  fallback?(draft: D): D;
}

export interface StageRunContext {
  /** Names the stage metrics and spans: `memory.<pipeline>.<stage>`. */
  readonly pipeline: string;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  /** Whether calls for a capability currently reach the model service. */
  readonly available: (capability: Capability) => boolean;
}

export interface StagesRun<D> {
  readonly draft: D;
  /** Stages that fell back; non-empty means the result is degraded. */
  readonly degraded: ReadonlySet<string>;
}

const TIMED_OUT = Symbol('timeout');

async function withTimeout<T>(
  run: Promise<T>,
  ms: number | undefined,
): Promise<T | typeof TIMED_OUT> {
  if (ms === undefined) return run;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => {
      resolve(TIMED_OUT);
    }, ms);
  });
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs stages in order with a span, a latency observation and the fallback rules per stage. */
export async function runStages<D>(
  stages: readonly Stage<D>[],
  initial: D,
  context: StageRunContext,
): Promise<Result<StagesRun<D>, MindlogError>> {
  const latency = context.metrics.histogram({
    name: 'mindlog_memory_stage_seconds',
    help: 'Memory pipeline stage latency',
    labelNames: ['pipeline', 'stage'],
  });
  let draft = initial;
  const degraded = new Set<string>();
  for (const stage of stages) {
    const labels = { pipeline: context.pipeline, stage: stage.name };
    if (stage.needs && !context.available(stage.needs) && stage.fallback) {
      draft = stage.fallback(draft);
      degraded.add(stage.name);
      continue;
    }
    const started = context.clock.monotonic();
    const result = await context.tracer.withSpan(
      `memory.${context.pipeline}.${stage.name}`,
      { 'mindlog.stage': stage.name },
      () => withTimeout(stage.run(draft, context), stage.timeoutMs),
    );
    latency.observe(Number(context.clock.monotonic() - started) / 1e9, labels);
    const failure: StageError | undefined =
      result === TIMED_OUT
        ? { kind: 'skippable', error: mindlogError('DEADLINE_EXCEEDED', `${stage.name} timed out`) }
        : result.ok
          ? undefined
          : result.error;
    if (!failure) {
      draft = (result as { ok: true; value: D }).value;
      continue;
    }
    if (failure.kind === 'fatal' || !stage.fallback) return err(failure.error);
    draft = stage.fallback(draft);
    degraded.add(stage.name);
  }
  return ok({ draft, degraded });
}
