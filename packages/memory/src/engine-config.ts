import type { BlobStore } from '@mindlog/blob';
import type { Clock, Logger, Metrics, Tracer } from '@mindlog/core';
import type { Capability, Models } from '@mindlog/models-client';
import type { CommandStamper } from '@mindlog/statemachine';
import type { IngestConfig } from './ingest/ingest-stages.js';
import type { PprRunner } from './recall/ppr.js';
import type { RecallConfig } from './recall/recall-stages.js';
import type { MemoryRange } from './types.js';
import type { VectorCache } from './vector-cache.js';

export interface MemoryConfig extends IngestConfig, RecallConfig {
  /** Default token budget of recall's packed context. */
  readonly tokenBudget: number;
  /** Jobs a user scope may hold before async remember answers BUSY (PLAN 12.7, ADR-0017). */
  readonly maxQueuedJobs: number;
  /** Most memories one taint cascade may forget (PLAN 13.4). */
  readonly maxCascade: number;
  /** Most memories a branch may hold (ADR-0013). */
  readonly branchMaxWrites: number;
  /** Delay of a scope's first consolidation tick after a write; 0 turns consolidation off (ADR-0033). */
  readonly tickDelayMs: number;
  /** How often recalled ids are proposed (PLAN 12.4 stage 10); 0 waits for `flushRecallStats`. */
  readonly recallStatsMs: number;
  /** Recalled ids a scope may have waiting. */
  readonly maxPendingRecalls: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  maxTextBytes: 32 * 1024,
  entityLabels: [
    'person',
    'organization',
    'place',
    'product',
    'project',
    // No 'preference' label: preferences are facts; as a label it tags verbs like "prefer".
    'date',
    'event',
  ],
  linkThreshold: 0.75,
  linkTopK: 5,
  retrieveK: 50,
  rerankK: 50,
  // PPR (PLAN 11.3, ADR-0011): HippoRAG's damping, linking_top_k and passage_node_weight.
  damping: 0.5,
  maxIterations: 30,
  tolerance: 1e-6,
  pprMaxNodes: 5000,
  pprMentionLimit: 50,
  pprEntitySeeds: 5,
  pprMemorySeedWeight: 0.05,
  themeMaxNodes: 2000,
  themeCount: 2,
  modelTimeoutMs: 2000,
  // ADR-0015, tuned on the phase 7 conflict set (docs/evals/phase-7.md).
  conflictThreshold: 0.95,
  conflictMinSimilarity: 0.5,
  duplicateThreshold: 0.9,
  conflictPolicy: 'quarantine_new',
  conflictCandidates: 5,
  trustedTools: [],
  trustedDomains: [],
  tokenBudget: 1000,
  maxQueuedJobs: 1000,
  maxCascade: 1000,
  branchMaxWrites: 1000,
  tickDelayMs: 10 * 60_000,
  recallStatsMs: 2000,
  maxPendingRecalls: 1000,
};

export interface MemoryEngineDeps {
  readonly models: Models;
  /** Whether calls for a capability currently reach the model service (`GuardedModels.available`). */
  readonly available?: (capability: Capability) => boolean;
  readonly stamper: CommandStamper;
  readonly ids: { next(): string };
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly vectors: VectorCache;
  /** Where PPR iterations run; inline by default, a worker pool in the server. */
  readonly ppr?: PprRunner;
  /** This node's replica of a range, for jobs (the enrich worker). */
  readonly ranges: (rangeId: bigint) => MemoryRange | undefined;
  /** The cold tier's blob store (PLAN 10.4); without it nothing goes cold. */
  readonly cold?: BlobStore;
  /** Whether lifecycle commands may be proposed (cluster version 8, ADR-0033); default yes. */
  readonly lifecycle?: () => boolean;
  readonly config?: Partial<MemoryConfig>;
}
