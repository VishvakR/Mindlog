import type {
  Clock,
  Logger,
  Metrics,
  MindlogConfig,
  MindlogError,
  Result,
  TlsProvider,
  Tracer,
} from '@mindlog/core';
import { SystemRandom, UlidGenerator } from '@mindlog/core';
import type { EventBus } from '@mindlog/eventbus';
import { resolve } from 'node:path';
import { masterKeyOf } from './open-encrypted.js';
import type { BlobStore } from '@mindlog/blob';
import { LocalBlobStore, S3BlobStore, EncryptingBlobStore } from '@mindlog/blob';
import { SemanticCache } from '@mindlog/cache';
import { ModelBudget, consolidationWorkers } from '@mindlog/consolidation';
import { WorkerRegistry } from '@mindlog/jobs';
import { MemoryEngine, VectorCache } from '@mindlog/memory';
import type { Capability, Models } from '@mindlog/models-client';
import { GrpcModels, GuardedModels, NoModels } from '@mindlog/models-client';
import type { AdmitClass, Authorize, RangeRouter } from '@mindlog/services';
import {
  ChangeFeed,
  LIFECYCLE_CLUSTER_VERSION,
  MemoryService,
  meterModels,
} from '@mindlog/services';
import type { CommandStamper } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { openPprPool } from './ppr-pool.js';

export interface MemoryParts {
  readonly service: MemoryService;
  readonly engine: MemoryEngine;
  /** Job workers the range jobs run (the `memory.enrich` worker). */
  readonly workers: WorkerRegistry;
  readonly models: Models;
  /** The memory change stream of this node's replicas (PLAN 13.5). */
  readonly changes: ChangeFeed;
  /** Proposes waiting recall stats and stops the PPR worker pool. */
  close(): Promise<void>;
}

/** Scopes whose vector index stays in memory (ADR-0008). */
const VECTOR_CACHE_SCOPES = 256;
/** PPR worker threads and the tasks that may wait for one (CLAUDE.md 5). */
const PPR_THREADS = 2;
const PPR_QUEUE = 64;

/** The cold tier's blob store (PLAN 10.4), or none when the tier is off. */
function openColdStore(config: MindlogConfig, clock: Clock): BlobStore | undefined {
  return config.storage.coldTier.enabled ? openBlobStore(config, clock) : undefined;
}

/** The node's configured blob store (`blob.default`). */
export function openBlobStore(config: MindlogConfig, clock: Clock): BlobStore {
  const b = config.blob.default;
  const store =
    b.type === 'local'
      ? new LocalBlobStore(resolve(config.node.dataDir, b.path))
      : new S3BlobStore({ ...b, clock });
  // The node refused to start already if the key were malformed (open-node-core).
  const master = masterKeyOf(config);
  return master.ok && master.value ? new EncryptingBlobStore(store, master.value) : store;
}

/**
 * The memory engine and its service (PLAN 12): the model client (or none, so
 * memory runs degraded), the vector cache following applied commands, and the
 * enrich worker. Model calls run only where a range leads (ADR-0016).
 */
export function openMemory(deps: {
  tls?: TlsProvider;
  authorize?: Authorize;
  admit?: (tenant: string, cls: AdmitClass) => Promise<Result<void, MindlogError>>;
  spendModel?: (tenant: string, ms: number) => void;
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
    const guarded = new GuardedModels(
      new GrpcModels({ address: endpoint, timeoutMs, ...(deps.tls ? { tls: deps.tls } : {}) }),
      {
        clock,
        metrics,
        bus: deps.events,
        failures: breakerFailures,
        openMs: breakerOpenMs,
      },
    );
    models = deps.spendModel ? meterModels(guarded, clock, deps.spendModel) : guarded;
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
  const cold = openColdStore(config, clock);
  const { consolidation, forgetting } = config.memory;
  const lifecycle = () =>
    (deps.clusterVersion?.() ?? LIFECYCLE_CLUSTER_VERSION) >= LIFECYCLE_CLUSTER_VERSION;
  const ranges = (rangeId: bigint) => {
    const target = router.local(rangeId);
    return target && { rangeId, proposer: target.proposer, reader: target.reader };
  };
  const ids = new UlidGenerator(clock, new SystemRandom());
  const engine = new MemoryEngine({
    models,
    available,
    stamper: deps.stamper,
    ids,
    clock,
    metrics,
    logger,
    tracer,
    vectors,
    ppr: ppr.run,
    lifecycle,
    ...(cold ? { cold } : {}),
    config: {
      modelTimeoutMs: timeoutMs,
      conflictThreshold: config.memory.conflicts.threshold,
      conflictMinSimilarity: config.memory.conflicts.minSimilarity,
      conflictPolicy: config.memory.conflicts.policy,
      trustedTools: config.memory.trust.tools,
      trustedDomains: config.memory.trust.domains.map((d) => d.toLowerCase()),
      tickDelayMs: consolidation.enabled ? consolidation.idleMs || 1 : 0,
    },
    ranges,
  });
  const workers = new WorkerRegistry();
  workers.register(engine.enrichWorker());
  for (const w of consolidationWorkers({
    engine,
    models,
    ranges,
    clock,
    ids,
    metrics,
    logger,
    tracer,
    budget: new ModelBudget(consolidation.modelSecondsPerHour, () => Number(clock.now())),
    config: {
      tickMs: consolidation.tickMs,
      idleMs: consolidation.idleMs,
      sleepAfter: consolidation.sleepAfter,
      sleepEveryMs: consolidation.sleepEveryMs,
      maxConflicts: consolidation.maxConflicts,
      modelSecondsPerHour: consolidation.modelSecondsPerHour,
      coldBelow: forgetting.coldBelow,
      hardForgetTenants: forgetting.hardForgetTenants,
      deleteBelow: forgetting.deleteBelow,
      modelTimeoutMs: config.models.timeoutMs * 10,
    },
    ...(cold ? { cold } : {}),
  }))
    workers.register(w);
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
    ...(deps.authorize ? { authorize: deps.authorize } : {}),
    ...(deps.admit ? { admit: deps.admit } : {}),
    engine,
    cache,
    router,
    stamper: deps.stamper,
    ...(deps.clusterVersion ? { clusterVersion: deps.clusterVersion } : {}),
  });
  const changes = new ChangeFeed();
  changes.attach(deps.events);
  return {
    service,
    engine,
    workers,
    models,
    changes,
    close: async () => {
      await engine.close();
      await ppr.close();
    },
  };
}
