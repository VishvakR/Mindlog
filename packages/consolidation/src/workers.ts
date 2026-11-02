import type { Worker } from '@mindlog/jobs';
import type { ConsolidationDeps } from './worker-kit.js';
import { cacheJanitor } from './workers/cache-janitor.js';
import { dedupWorker } from './workers/dedup.js';
import { entitySummarizer } from './workers/entity-summarizer.js';
import { evolutionWorker } from './workers/evolution.js';
import { forgettingWorker } from './workers/forgetting.js';
import { reembedWorker } from './workers/reembed.js';
import { sleepTimeWorker } from './workers/sleep-time.js';
import { themeWorker } from './workers/themes.js';
import { tickWorker } from './workers/tick.js';

/** Every consolidation worker (PLAN 12.6), to register with the job runner's `WorkerRegistry`. */
export function consolidationWorkers(deps: ConsolidationDeps): Worker[] {
  return [
    tickWorker(deps),
    sleepTimeWorker(deps),
    evolutionWorker(deps),
    dedupWorker(deps),
    themeWorker(deps),
    entitySummarizer(deps),
    forgettingWorker(deps),
    reembedWorker(deps),
    cacheJanitor(deps),
  ];
}
