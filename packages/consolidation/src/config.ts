/** Consolidation settings (config `memory.consolidation` and `memory.forgetting`, ADR-0033). */
export interface ConsolidationConfig {
  /** Between ticks of a scope with work left. */
  readonly tickMs: number;
  /** Sleep-time waits for the scope to be idle this long. */
  readonly idleMs: number;
  /** Sleep-time after this many new memories once idle, or every `sleepEveryMs`. */
  readonly sleepAfter: number;
  readonly sleepEveryMs: number;
  /** A sleep branch raising more conflicts than this is dropped. */
  readonly maxConflicts: number;
  /** Model time each tenant's workers may use per hour (node-local). */
  readonly modelSecondsPerHour: number;
  /** Retention below which memory goes cold (PLAN 13.7: 0.2). */
  readonly coldBelow: number;
  /** Tenants that allow deleting memory below `deleteBelow` retention (default none). */
  readonly hardForgetTenants: readonly string[];
  readonly deleteBelow: number;
  readonly modelTimeoutMs: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  tickMs: 15 * 60_000,
  idleMs: 10 * 60_000,
  sleepAfter: 20,
  sleepEveryMs: 24 * 3_600_000,
  maxConflicts: 3,
  modelSecondsPerHour: 600,
  coldBelow: 0.2,
  hardForgetTenants: [],
  deleteBelow: 0.02,
  modelTimeoutMs: 20_000,
};

const HOUR = 3_600_000;

/** How often the periodic workers run at most (PLAN 12.6). */
export const EVERY = {
  dedup: 24 * HOUR,
  forget: HOUR,
  entities: HOUR,
  cache: 5 * 60_000,
} as const;

/** Graph growth since the last theme build that rebuilds themes (PLAN 12.6: 5%), and the least graph. */
export const THEME_GROWTH = 0.05;
export const THEME_MIN_GRAPH = 10;
