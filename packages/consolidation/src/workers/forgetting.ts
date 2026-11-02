import { ok } from '@mindlog/core';
import type { Worker } from '@mindlog/jobs';
import type { ColdEntry } from '@mindlog/memory';
import { LIFECYCLE_JOBS, encodeSegment, retentionAt, stubText } from '@mindlog/memory';
import type { MemoryRecord } from '@mindlog/proto';
import type { ConsolidationDeps, Run } from '../worker-kit.js';
import { worker } from '../worker-kit.js';

/** Memories per cold segment, and so per command. */
const BATCH = 100;
/** Hard forgetting needs low importance too (PLAN 13.7). */
const DELETE_IMPORTANCE = 0.2;

/** Memories some hot memory links to; they are never hard-forgotten (PLAN 13.7). */
async function linkedFromHot(run: Run): Promise<Set<string>> {
  const out = new Set<string>();
  for await (const r of run.reads.records())
    if (r.expiredAt === 0n && r.tier !== 'cold') for (const l of r.links) out.add(l.to);
  return out;
}

async function toCold(d: ConsolidationDeps, run: Run, batch: MemoryRecord[], n: number) {
  const cold = d.cold;
  if (!cold || batch.length === 0) return ok(undefined);
  const entries: ColdEntry[] = [];
  for (const record of batch) {
    const v = await run.reads.vector(record.id);
    entries.push({ record, vector: v?.vector ?? new Uint8Array(), modelId: v?.modelId ?? '' });
  }
  const seg = encodeSegment(run.scope.tenant, run.scope.user, entries);
  // Durable before any command names it (ADR-0033).
  const put = await cold.put(seg.key, seg.bytes);
  if (!put.ok) return put;
  const moved = await run.maintain(n, {
    tier: batch.map((r) => ({
      id: r.id,
      tier: 'cold',
      segment: seg.key,
      sha256: seg.sha256,
      text: stubText(r.text),
    })),
  });
  if (!moved.ok) return moved;
  d.metrics
    .counter({
      name: 'mindlog_memory_tier_moves_total',
      help: 'Memories moved between tiers',
      labelNames: ['tier'],
    })
    .inc(moved.value.count, { tier: 'cold' });
  return ok(undefined);
}

/**
 * ForgettingWorker (PLAN 12.6, 13.7): memories whose retention fell below the
 * cold threshold move to the cold tier; with hard forgetting on for the
 * tenant, faded unimportant memories nothing hot links to are forgotten.
 */
export function forgettingWorker(d: ConsolidationDeps): Worker {
  return worker(LIFECYCLE_JOBS.forget, d, async (run) => {
    const { coldBelow, deleteBelow, hardForgetTenants } = d.config;
    const hard = hardForgetTenants.includes(run.scope.tenant);
    const now = Number(run.nowMs);
    const linked = hard ? await linkedFromHot(run) : new Set<string>();
    const forget: string[] = [];
    let batch: MemoryRecord[] = [];
    let n = 0;
    for await (const r of run.reads.records()) {
      if (r.expiredAt !== 0n || r.pinned) continue;
      const retention = retentionAt(r, now);
      if (hard && retention < deleteBelow && r.importance < DELETE_IMPORTANCE && !linked.has(r.id))
        forget.push(r.id);
      else if (r.tier !== 'cold' && retention < coldBelow) batch.push(r);
      if (batch.length === BATCH) {
        const moved = await toCold(d, run, batch, n++);
        if (!moved.ok) return moved;
        batch = [];
      }
    }
    const moved = await toCold(d, run, batch, n);
    if (!moved.ok) return moved;
    if (forget.length > 0) {
      const done = await d.engine.forget(
        run.range,
        { scope: run.scope, ids: forget, reason: 'forgetting curve' },
        run.context('forget'),
      );
      if (!done.ok) return done;
    }
    // Re-running is safe: cold memories are skipped, so no checkpoint is needed.
    return run.finish();
  });
}
