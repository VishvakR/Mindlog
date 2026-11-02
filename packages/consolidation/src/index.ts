/**
 * @mindlog/consolidation — background workers that improve and forget memory
 * (PLAN 12.6, 13.7; ADR-0033): a per-scope tick decides what is due; the
 * workers write through the normal command path.
 */
export { ModelBudget } from './budget.js';
export type { ConsolidationConfig } from './config.js';
export { DEFAULT_CONSOLIDATION_CONFIG, EVERY, THEME_GROWTH, THEME_MIN_GRAPH } from './config.js';
export type { ScheduleFacts, TickPlan } from './schedule.js';
export { planTick } from './schedule.js';
export type { ConsolidationDeps, Run } from './worker-kit.js';
export { consolidationWorkers } from './workers.js';
export { DUPLICATE_SIMILARITY } from './workers/dedup.js';
export { SUMMARY_AFTER } from './workers/entity-summarizer.js';
