import type { Command } from '@mindlog/proto';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
  keyPrefix,
  prefixRange,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import type { MemoryConfig, MemoryRange, PprRunner } from '@mindlog/memory';
import {
  MemoryEngine,
  VectorCache,
  memoryCommitHandler,
  memoryForgetHandler,
} from '@mindlog/memory';
import { FakeModels } from '@mindlog/models-client';
import { startSingleNode } from '@mindlog/multiraft';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

export const START = 1_760_000_000_000n;
export const TENANT = 'acme';

/** A one-voter range with the memory and job handlers, and an engine over FakeModels. */
export async function memoryNode(
  options: { seed?: bigint; config?: Partial<MemoryConfig>; ppr?: PprRunner } = {},
) {
  const clock = new ManualClock(START);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [memoryCommitHandler, memoryForgetHandler, jobLeaseHandler, jobCompleteHandler])
    handlers.register(h);
  const store = new MemoryStore();
  const events = new InMemoryEventBus({ logger, metrics });
  const descriptor = wholeKeyspace(1n);
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events,
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor,
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const random = new SeededRandom(options.seed ?? 1n);
  const hlc = new HybridLogicalClock(clock, { maxOffsetMs: 500n });
  const stamper = new CommandStamper(hlc, new UlidGenerator(clock, random));
  const models = new FakeModels();
  const vectors = new VectorCache({ state: store, maxScopes: 16, metrics });
  vectors.attach(events);
  const range: MemoryRange = {
    rangeId: 1n,
    proposer: replica,
    reader: new SpanReader(store, replica.descriptor),
  };
  const engine = new MemoryEngine({
    models,
    stamper,
    ids: new UlidGenerator(clock, random),
    clock,
    metrics,
    logger,
    tracer: new OtelTracer(),
    vectors,
    ranges: (id) => (id === 1n ? range : undefined),
    ...(options.config ? { config: options.config } : {}),
    ...(options.ppr ? { ppr: options.ppr } : {}),
  });
  const propose = async (command: Command) => {
    const proposed = await replica.propose(command);
    if (!proposed.ok) throw new Error(proposed.error.message);
    return proposed.value.result;
  };
  /** Every key and value of the tenant's data, for comparing replicas. */
  const dump = async (): Promise<string[]> => {
    const out: string[] = [];
    const tenant = keyPrefix(TENANT);
    if (!tenant.ok) throw new Error('prefix');
    for await (const [k, v] of store.iterate(prefixRange(tenant.value)))
      out.push(`${Buffer.from(k).toString('hex')}=${Buffer.from(v).toString('hex')}`);
    return out;
  };
  return {
    clock,
    store,
    replica,
    stamper,
    models,
    engine,
    range,
    vectors,
    events,
    logger,
    metrics,
    propose,
    dump,
    descriptor,
  };
}

export const scope = (user = 'u1', extra: { agent?: string; session?: string } = {}) => ({
  tenant: TENANT,
  user,
  ...extra,
});
export const ctx = { principal: 'agent:test' };
