import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import type { ScopeLifecycle } from '@mindlog/proto';
import { ScopeLifecycleSchema } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';
import { lifecycleKey } from './keys.js';

/** Job kinds of the consolidation workers (PLAN 12.6, ADR-0033); apply resets their triggers on enqueue. */
export const LIFECYCLE_JOBS = {
  tick: 'consolidation.tick',
  sleep: 'consolidation.sleep',
  evolve: 'consolidation.evolve',
  dedup: 'consolidation.dedup',
  themes: 'consolidation.themes',
  entities: 'consolidation.entities',
  forget: 'consolidation.forget',
  reembed: 'consolidation.reembed',
  cache: 'consolidation.cache',
} as const;
export type LifecycleJob = (typeof LIFECYCLE_JOBS)[keyof typeof LIFECYCLE_JOBS];

/** Forgetting curve (PLAN 13.7): days of stability of a new memory. */
export const initialStrength = (importance: number): number => 1 + 9 * importance;

const DAY_MS = 86_400_000;

/** Strength after a recall `days` after the last one: spaced recalls count more (MemoryBank). */
export function strengthAfterRecall(strength: number, days: number): number {
  const s = Math.max(strength, 1e-6);
  return s * (1 + 0.5 * Math.min(1, Math.max(0, days) / s));
}

/** Retention `e^(−t/S)` of a memory at `nowMs`, t from its last recall or its creation. */
export function retentionAt(
  r: { readonly strength: number; readonly lastRecalledAt: bigint; readonly createdAt: bigint },
  nowMs: number,
): number {
  const last = Number((r.lastRecalledAt || r.createdAt) >> 16n);
  return Math.exp(-Math.max(0, nowMs - last) / DAY_MS / Math.max(r.strength || 1, 1e-6));
}

export async function readLifecycle(
  ctx: ApplyContext,
  tenant: string,
  user: string,
): Promise<ScopeLifecycle> {
  const bytes = await ctx.txn.get(lifecycleKey(tenant, user));
  return bytes ? fromBinary(ScopeLifecycleSchema, bytes) : create(ScopeLifecycleSchema);
}

/** Reads, changes and writes a scope's lifecycle state inside an apply. */
export async function updateLifecycle(
  ctx: ApplyContext,
  tenant: string,
  user: string,
  change: (s: ScopeLifecycle) => void,
): Promise<ScopeLifecycle> {
  const s = await readLifecycle(ctx, tenant, user);
  change(s);
  ctx.txn.put(lifecycleKey(tenant, user), toBinary(ScopeLifecycleSchema, s));
  return s;
}

/** What enqueueing a worker job resets in the state (its trigger counts). */
export function markEnqueued(s: ScopeLifecycle, kind: string, nowMs: bigint): void {
  s.lastRunMs[kind] = nowMs;
  if (kind === LIFECYCLE_JOBS.sleep) s.writesSinceSleep = 0;
  if (kind === LIFECYCLE_JOBS.evolve) s.writesSinceEvolve = 0;
  if (kind === LIFECYCLE_JOBS.themes) s.graphSizeAtTheme = s.graphSize;
}
