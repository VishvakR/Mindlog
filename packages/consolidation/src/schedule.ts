import type { ScopeLifecycle } from '@mindlog/proto';
import { LIFECYCLE_JOBS, SPLIT_JOB } from '@mindlog/memory';
import type { ConsolidationConfig } from './config.js';
import { EVERY, THEME_GROWTH, THEME_MIN_GRAPH } from './config.js';

export interface ScheduleFacts {
  /** Worker kinds with a job still queued or leased (not enqueued again). */
  readonly running: ReadonlySet<string>;
  /** The scope has semantic-cache entries. */
  readonly hasCache: boolean;
  /** A cold tier is configured. */
  readonly coldTier: boolean;
  /** The scope is split, or is a cluster of one (ADR-0039): its drift is checked hourly. */
  readonly split?: boolean;
}

export interface TickPlan {
  /** Worker kinds due now, with why (shown on the Jobs page). */
  readonly due: ReadonlyArray<{ readonly kind: string; readonly why: string }>;
  /** Whether the scope keeps ticking. */
  readonly again: boolean;
}

/**
 * What a scope's tick enqueues (PLAN 12.6 triggers, ADR-0033): a pure
 * function of its lifecycle state, the time and a few facts, so the
 * schedule is testable and explainable.
 */
export function planTick(
  s: ScopeLifecycle,
  nowMs: bigint,
  c: Pick<ConsolidationConfig, 'idleMs' | 'sleepAfter' | 'sleepEveryMs'> &
    Partial<Pick<ConsolidationConfig, 'splitAt'>>,
  f: ScheduleFacts,
): TickPlan {
  const last = (kind: string) => s.lastRunMs[kind] ?? 0n;
  const since = (kind: string) => nowMs - last(kind);
  const idle = nowMs - s.lastWriteMs >= BigInt(c.idleMs);
  const written = (kind: string) => s.lastWriteMs > last(kind);
  const due: Array<{ kind: string; why: string }> = [];
  const add = (kind: string, why: string) => {
    if (!f.running.has(kind)) due.push({ kind, why });
  };
  if (s.writesSinceSleep > 0) {
    if (idle && s.writesSinceSleep >= c.sleepAfter)
      add(LIFECYCLE_JOBS.sleep, `${String(s.writesSinceSleep)} new memories, idle`);
    else if (since(LIFECYCLE_JOBS.sleep) >= BigInt(c.sleepEveryMs))
      add(LIFECYCLE_JOBS.sleep, 'a day since the last sleep run');
  }
  if (s.writesSinceEvolve > 0)
    add(LIFECYCLE_JOBS.evolve, `${String(s.writesSinceEvolve)} new memories`);
  if (
    s.hot >= 2 &&
    written(LIFECYCLE_JOBS.dedup) &&
    since(LIFECYCLE_JOBS.dedup) >= BigInt(EVERY.dedup)
  )
    add(LIFECYCLE_JOBS.dedup, 'nightly');
  if (s.graphSize >= THEME_MIN_GRAPH && s.graphSize > s.graphSizeAtTheme * (1 + THEME_GROWTH))
    add(
      LIFECYCLE_JOBS.themes,
      `graph grew from ${String(s.graphSizeAtTheme)} to ${String(s.graphSize)}`,
    );
  if (written(LIFECYCLE_JOBS.entities) && since(LIFECYCLE_JOBS.entities) >= BigInt(EVERY.entities))
    add(LIFECYCLE_JOBS.entities, 'new mentions');
  if (s.hot > 0 && since(LIFECYCLE_JOBS.forget) >= BigInt(EVERY.forget))
    add(LIFECYCLE_JOBS.forget, 'hourly');
  if (s.reembed) add(LIFECYCLE_JOBS.reembed, 'vectors of another model remain');
  if (f.hasCache && since(LIFECYCLE_JOBS.cache) >= BigInt(EVERY.cache))
    add(LIFECYCLE_JOBS.cache, 'cache entries may have expired');
  const splitAt = c.splitAt ?? 0;
  if (splitAt > 0) {
    if (s.hot >= splitAt && since(SPLIT_JOB) >= BigInt(EVERY.split))
      add(SPLIT_JOB, `${String(s.hot)} memories, the split threshold is ${String(splitAt)}`);
    else if (f.split && s.hot > 0 && since(SPLIT_JOB) >= BigInt(EVERY.drift))
      add(SPLIT_JOB, 'hourly drift check of a split scope');
  }
  // A scope keeps ticking while something can still change without a write.
  const again = s.hot > 0 || s.reembed || f.hasCache || due.length > 0;
  return { due, again };
}
