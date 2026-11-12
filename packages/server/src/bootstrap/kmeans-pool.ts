import { Piscina } from 'piscina';
import type { KmeansRunner, TwoMeans } from '@mindlog/memory';
import { inlineKmeans } from '@mindlog/memory';

const WORKER = new URL('./kmeans-worker.js', import.meta.url);

export interface KmeansPool {
  readonly run: KmeansRunner;
  readonly close: () => Promise<void>;
}

/**
 * k-means for semantic splits on one worker thread: splits are rare and
 * large, and must not stall the event loop.
 * shortcut: inline when running from TypeScript sources (tests), where the compiled worker is absent.
 */
export function openKmeansPool(): KmeansPool {
  if (!import.meta.url.endsWith('.js'))
    return { run: inlineKmeans, close: () => Promise.resolve() };
  const pool = new Piscina({
    filename: WORKER.href,
    name: 'kmeans',
    minThreads: 0,
    maxThreads: 1,
    maxQueue: 8,
  });
  return {
    run: async (vectors, seed) => (await pool.run({ vectors: [...vectors], seed })) as TwoMeans,
    close: () => pool.destroy(),
  };
}
