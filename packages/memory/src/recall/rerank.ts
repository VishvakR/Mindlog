import { err, ok } from '@mindlog/core';
import type { Models } from '@mindlog/models-client';
import type { Stage } from '../pipeline/stage.js';
import type { RecallDraft } from './recall-draft.js';
import { withSignal } from './recall-draft.js';

/**
 * Optional cross-encoder rerank of the best fused candidates (PLAN 12.4
 * stage 6). The candidates outside the top `rerankK` are dropped, so every
 * remaining one has a rerank score; skipped (degraded) when the model is down.
 */
export function rerankStage(
  models: Models,
  config: { readonly rerankK: number; readonly modelTimeoutMs: number },
): Stage<RecallDraft> {
  const timeoutMs = config.modelTimeoutMs;
  return {
    name: 'rerank',
    needs: 'rerank',
    timeoutMs,
    async run(d) {
      if (d.records.length === 0) return ok(d);
      const records = d.records.slice(0, config.rerankK);
      const r = await models.rerank(
        d.input.query,
        records.map((m) => m.text),
        { timeoutMs },
      );
      if (!r.ok) return err({ kind: 'skippable', error: r.error });
      const hits = records.map((m, i) => ({ id: m.id, score: r.value.scores[i] ?? 0 }));
      return ok({ ...d, records, signals: withSignal(d.signals, hits, 'rerank') });
    },
    fallback: (d) => d,
  };
}
