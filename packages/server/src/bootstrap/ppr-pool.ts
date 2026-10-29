import type { Logger, Metrics } from '@mindlog/core';
import type { PprRunner } from '@mindlog/memory';
import { inlinePpr } from '@mindlog/memory';
import { Piscina } from 'piscina';

export interface PprPool {
  readonly run: PprRunner;
  readonly close: () => Promise<void>;
}

const WORKER = new URL('./ppr-worker.js', import.meta.url);

/**
 * PPR iterations on a bounded worker pool. A full queue skips the retriever
 * (zero scores) instead of queueing without bound.
 *
 * shortcut: inline when running from TypeScript sources (tests), where the compiled worker is absent.
 */
export function openPprPool(deps: {
  readonly threads: number;
  readonly maxQueue: number;
  readonly metrics: Metrics;
  readonly logger: Logger;
}): PprPool {
  if (!import.meta.url.endsWith('.js')) return { run: inlinePpr, close: () => Promise.resolve() };
  const pool = new Piscina({
    filename: WORKER.href,
    name: 'ppr',
    minThreads: 1,
    maxThreads: deps.threads,
    maxQueue: deps.maxQueue,
  });
  const shed = deps.metrics.counter({
    name: 'mindlog_memory_ppr_shed_total',
    help: 'PPR runs skipped because the worker queue was full',
  });
  return {
    run: async (graph, seed, options) => {
      try {
        return (await pool.run({ graph, seed, options })) as Float64Array;
      } catch (e) {
        shed.inc();
        deps.logger.warn('ppr worker run failed; the retriever is skipped', {
          error: e instanceof Error ? e.message : String(e),
        });
        return new Float64Array(graph.ids.length);
      }
    },
    close: () => pool.destroy(),
  };
}
