import { ok } from '@mindlog/core';
import type { Worker } from '@mindlog/jobs';
import { LIFECYCLE_JOBS, vectorBytes } from '@mindlog/memory';
import type { MemoryRecord } from '@mindlog/proto';
import type { ConsolidationDeps } from '../worker-kit.js';
import { deferred, worker } from '../worker-kit.js';

/** Texts per embedding call and command. */
const BATCH = 32;

/**
 * ReembedWorker (PLAN 12.6, ADR-0033): re-embeds hot memories whose vector is
 * of another model than the scope's (or missing), in checkpointed batches,
 * and clears the scope's re-embed mark when none are left.
 */
export function reembedWorker(d: ConsolidationDeps): Worker {
  return worker(LIFECYCLE_JOBS.reembed, d, async (run) => {
    const state = await d.engine.lifecycle(run.range, run.scope);
    const after = state.checkpoints[LIFECYCLE_JOBS.reembed] || undefined;
    let model = state.embedModel;
    let n = 0;
    let batch: MemoryRecord[] = [];
    const flush = async (last: boolean) => {
      let vectors: Uint8Array[] = [];
      if (batch.length > 0) {
        const r = await run.model(() =>
          d.models.embed(
            batch.map((x) => x.text),
            'passage',
            { timeoutMs: d.config.modelTimeoutMs },
          ),
        );
        if (!r) return 'deferred' as const;
        if (!r.ok) return r;
        model = r.value.modelId;
        vectors = r.value.vectors.map((v) => vectorBytes(v));
      }
      const done = await run.maintain(n++, {
        reembed: batch.map((x, i) => ({ id: x.id, vector: vectors[i] ?? new Uint8Array() })),
        reembedModel: model,
        reembedDone: last,
        checkpointWorker: LIFECYCLE_JOBS.reembed,
        checkpoint: last ? '' : (batch.at(-1)?.id ?? ''),
        ...(last ? { complete: { id: run.job.job.id, attempt: run.job.attempt } } : {}),
      });
      batch = [];
      return done.ok ? ok(undefined) : done;
    };
    for await (const r of run.reads.records(after)) {
      if (r.expiredAt !== 0n || r.tier === 'cold') continue;
      const v = await run.reads.vector(r.id);
      if (v && v.modelId === model && model !== '') continue;
      batch.push(r);
      if (batch.length < BATCH) continue;
      const done = await flush(false);
      if (done === 'deferred') return deferred(d, run);
      if (!done.ok) return done;
    }
    const done = await flush(true);
    if (done === 'deferred') return deferred(d, run);
    return done.ok ? ok({ completed: true }) : done;
  });
}
