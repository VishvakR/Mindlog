import { create, fromBinary } from '@bufbuild/protobuf';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  completeJob,
  enqueueJob,
  jobCompleteHandler,
  jobKey,
  jobLeaseHandler,
  jobRangeHooks,
} from '@mindlog/jobs';
import { startSingleNode } from '@mindlog/multiraft';
import type { CommandResult, Job, JobSpec } from '@mindlog/proto';
import { CommandResultSchema, JobSchema } from '@mindlog/proto';
import type { ApplyHandler } from '@mindlog/statemachine';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore, MvccReader } from '@mindlog/storage';

type Body = Parameters<CommandStamper['stamp']>[2];
export const START = 1_760_000_000_000n;
export const TENANT = 'default';

/**
 * Stands in for the memory engine's MemoryCommit: enqueues its jobs and completes
 * the referenced one, using the public jobs API the real handler uses.
 */
const commitStandIn: ApplyHandler = {
  body: 'memoryCommit',
  async apply(ctx) {
    if (ctx.command.body.case !== 'memoryCommit') throw new Error('wrong body');
    const commit = ctx.command.body.value;
    if (commit.complete) {
      const completed = await completeJob(ctx, commit.user, commit.complete);
      if (completed.outcome.case === 'error') return completed;
    }
    for (const spec of commit.enqueue) {
      const failed = enqueueJob(ctx, commit.user, spec);
      if (failed) return failed;
    }
    return create(CommandResultSchema, {
      outcome: { case: 'memory', value: { ids: [], count: commit.enqueue.length } },
    });
  },
};

/** A one-voter range with the job handlers over memory stores. */
export async function jobNode() {
  const clock = new ManualClock(START);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [jobLeaseHandler, jobCompleteHandler, commitStandIn]) handlers.register(h);
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor: wholeKeyspace(1n),
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const hlc = new HybridLogicalClock(clock, { maxOffsetMs: 500n });
  const stamper = new CommandStamper(hlc, new UlidGenerator(clock, new SeededRandom(1n)));
  const propose = async (body: Body): Promise<CommandResult> => {
    const proposed = await replica.propose(stamper.stamp(TENANT, 'test', body));
    if (!proposed.ok) throw new Error(proposed.error.message);
    return proposed.value.result;
  };
  const enqueue = (user: string, ...specs: Partial<JobSpec>[]) =>
    propose({
      case: 'memoryCommit',
      value: {
        user,
        memories: [],
        edges: [],
        enqueue: specs.map((s) => ({
          id: 'j1',
          kind: 'test',
          payload: new Uint8Array(),
          runAtMs: 0n,
          ...s,
        })),
      },
    });
  const job = async (user: string, id: string): Promise<Job | undefined> => {
    const bytes = await new MvccReader(store).get(jobKey(TENANT, user, id));
    return bytes ? fromBinary(JobSchema, bytes) : undefined;
  };
  return { clock, store, replica, stamper, metrics, logger, propose, enqueue, job };
}
