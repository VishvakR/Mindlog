import type { Clock, Logger, Metrics, MindlogConfig, Tracer } from '@mindlog/core';
import { SystemRandom, UlidGenerator } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import { SemanticCache } from '@mindlog/cache';
import { WorkerRegistry } from '@mindlog/jobs';
import { MemoryEngine, VectorCache } from '@mindlog/memory';
import type { Capability, Models } from '@mindlog/models-client';
import { GrpcModels, GuardedModels, NoModels } from '@mindlog/models-client';
import type { RangeRouter } from '@mindlog/services';
import { MemoryService } from '@mindlog/services';
import type { CommandStamper } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { openPprPool } from './ppr-pool.js';

export interface MemoryParts {
  readonly service: MemoryService;
  readonly engine: MemoryEngine;
  /** Job workers the range jobs run (the `memory.enrich` worker). */
  readonly workers: WorkerRegistry;
  readonly models: Models;
  /** Stops the PPR worker pool. */
  close(): Promise<void>;
}

/** Scopes whose vector index stays in memory (ADR-0008). */
const VECTOR_CACHE_SCOPES = 256;
/** PPR worker threads and the tasks that may wait for one (CLAUDE.md 5). */
const PPR_THREADS = 2;
const PPR_QUEUE = 64;

/**
 * The memory engine and its service (PLAN 12): the model client (or none, so
 * memory runs degraded), the vector cache following applied commands, and the
 * enrich worker. Model calls run only where a range leads (ADR-0016).
 */
export function openMemory(deps: {
  readonly config: MindlogConfig;
  readonly state: KvReader;
  readonly events: EventBus;
  readonly stamper: CommandStamper;
  readonly router: RangeRouter;
  readonly clusterVersion?: () => number;
  readonly clock: Clock;
  readonly metrics: Metrics;
  readonly logger: Logger;
  readonly tracer: Tracer;
}): MemoryParts {
  const { config, clock, metrics, logger, tracer, router } = deps;
  const { endpoint, timeoutMs, breakerFailures, breakerOpenMs } = config.models;
  let models: Models;
  let available: (capability: Capability) => boolean;
  if (endpoint) {
    const guarded = new GuardedModels(new GrpcModels({ address: endpoint, timeoutMs }), {
      clock,
      metrics,
      bus: deps.events,
      failures: breakerFailures,
      openMs: breakerOpenMs,
    });
    models = guarded;
    available = (c) => guarded.available(c);
  } else {
    logger.warn('no model service configured (models.endpoint): memory runs in degraded mode');
    const none = new NoModels();
    models = none;
    available = () => none.available();
  }
  const vectors = new VectorCache({
    state: deps.state,
    maxScopes: VECTOR_CACHE_SCOPES,
    metrics,
    logger,
  });
  vectors.attach(deps.events);
  const ppr = openPprPool({ threads: PPR_THREADS, maxQueue: PPR_QUEUE, metrics, logger });
  const engine = new MemoryEngine({
    models,
    available,
    stamper: deps.stamper,
    ids: new UlidGenerator(clock, new SystemRandom()),
    clock,
    metrics,
    logger,
    tracer,
    vectors,
    ppr: ppr.run,
    config: {
      modelTimeoutMs: timeoutMs,
      conflictThreshold: config.memory.conflicts.threshold,
      conflictPolicy: config.memory.conflicts.policy,
      trustedTools: config.memory.trust.tools,
      trustedDomains: config.memory.trust.domains.map((d) => d.toLowerCase()),
    },
    ranges: (rangeId) => {
      const target = router.local(rangeId);
      return target && { rangeId, proposer: target.proposer, reader: target.reader };
    },
  });
  const workers = new WorkerRegistry();
  workers.register(engine.enrichWorker());
  const cache = new SemanticCache({
    models,
    stamper: deps.stamper,
    ids: new UlidGenerator(clock, new SystemRandom()),
    clock,
    metrics,
    tracer,
    config: { modelTimeoutMs: timeoutMs },
  });
  const service = new MemoryService({
    engine,
    cache,
    router,
    stamper: deps.stamper,
    ...(deps.clusterVersion ? { clusterVersion: deps.clusterVersion } : {}),
  });
  return { service, engine, workers, models, close: ppr.close };
}
