import type { MailMessage, Mailer } from '@mindlog/auth';
import { recordWriteHandler, schemaChangeHandler } from '@mindlog/collections';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
  err,
  mindlogError,
  ok,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import { jobCompleteHandler, jobLeaseHandler, jobRangeHooks } from '@mindlog/jobs';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvWriteHandler,
} from '@mindlog/kv';
import { startSingleNode } from '@mindlog/multiraft';
import type {
  CollectionServiceDeps,
  RangeRouter,
  RangeTarget,
  RequestContext,
} from '@mindlog/services';
import {
  AppAuthService,
  CollectionService,
  KvService,
  StaticAuthenticator,
} from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  StateMachine,
  inSpan,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

export const TENANT = 'acme';

/** Captures mail instead of sending it. */
export class OutboxMailer implements Mailer {
  readonly sent: MailMessage[] = [];

  send(message: MailMessage) {
    this.sent.push(message);
    return Promise.resolve(ok(undefined));
  }
}

/**
 * One range holding everything, with the KV, collection and job handlers,
 * served by a `CollectionService` and an `AppAuthService`. With `remote` the
 * service holds no replica: calls are forwarded to a stand-in that does.
 */
export async function collectionsNode(
  options: {
    remote?: boolean;
    mailer?: boolean;
    deps?: Partial<CollectionServiceDeps>;
  } = {},
) {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const registry = createKvRegistry();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [
    kvWriteHandler(registry),
    kvBatchHandler(registry),
    expireHandler,
    gcThresholdHandler,
    recordWriteHandler,
    schemaChangeHandler,
    jobLeaseHandler,
    jobCompleteHandler,
  ])
    handlers.register(h);
  const store = new MemoryStore();
  const span = wholeKeyspace(1n);
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [jobRangeHooks],
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
    rangeId: 1n,
    descriptor: span,
  });
  const replica = await startSingleNode({
    log: new RaftLogStore(new MemoryStore(), 1n),
    machine,
    clock,
    logger,
    metrics,
    rangeId: 1n,
  });
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, new SeededRandom(1n)),
  );
  const kv = new KvService({
    registry,
    store,
    proposer: replica,
    readBarrier: replica,
    stamper,
    clock,
    authenticator: new StaticAuthenticator(undefined),
    metrics,
    tracer: new OtelTracer(),
  });
  const target: RangeTarget = {
    rangeId: 1n,
    proposer: replica,
    readBarrier: replica,
    reader: new SpanReader(store, span),
    state: store,
    descriptor: () => span,
    owns: () => true,
    covers: (key) => inSpan(span, key),
  };
  const holder: { service?: CollectionService } = {};
  const local = options.remote !== true;
  let forwarded = 0;
  const router: RangeRouter = {
    place: () => Promise.resolve(ok([])),
    locate: () =>
      Promise.resolve(ok(local ? { rangeId: 1n, local: target } : { rangeId: 1n, address: 'n2' })),
    refresh: (p) => Promise.resolve(ok(p)),
    forward: async (p, caller, call) => {
      forwarded++;
      const reply = await holder.service?.forwarded(p.rangeId, caller, call);
      return reply ? ok(reply) : err(mindlogError('UNAVAILABLE', 'no holder'));
    },
    ranges: () =>
      Promise.resolve(
        ok([local ? { rangeId: 1n, local: target } : { rangeId: 1n, address: 'n2' }]),
      ),
    local: () => (local ? target : undefined),
    any: () => target,
  };
  const collections = new CollectionService({ router, stamper, clock, ...options.deps });
  holder.service = new CollectionService({
    router: { ...router, local: () => target },
    stamper,
    clock,
  });
  const mailer = options.mailer ? new OutboxMailer() : undefined;
  const auth = new AppAuthService({ collections, kv, clock, ...(mailer ? { mailer } : {}) });
  const superuser: RequestContext = {
    identity: { kind: 'superuser', email: 'admin@x.io' },
    tenant: TENANT,
  };
  const anonymous: RequestContext = { identity: { kind: 'anonymous' }, tenant: TENANT };
  const as = (id: string, collection = 'users'): RequestContext => ({
    identity: { kind: 'record', tenant: TENANT, collection, id },
    tenant: TENANT,
  });
  return {
    clock,
    store,
    collections,
    auth,
    kv,
    mailer,
    superuser,
    anonymous,
    as,
    forwarded: () => forwarded,
  };
}
