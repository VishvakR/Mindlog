import { create } from '@bufbuild/protobuf';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
  mindlogError,
  err,
  ok,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  headerKey,
  kvBatchHandler,
  kvRangeHooks,
  kvWriteHandler,
} from '@mindlog/kv';
import { startSingleNode } from '@mindlog/multiraft';
import { RangeDescriptorSchema } from '@mindlog/proto';
import type { Placement, RangeCall, RangeRouter, RangeTarget } from '@mindlog/services';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  lockGuard,
  txnRangeHooks,
  txnCheckHandler,
  txnCommitHandler,
  txnPrewriteHandler,
  txnRollbackHandler,
} from '@mindlog/txn';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  SpanReader,
  inSpan,
  StateMachine,
} from '@mindlog/statemachine';
import { MemoryStore, compareBytes } from '@mindlog/storage';
import { plain } from './service-node.js';

const encoder = new TextEncoder();

export interface Forwarded {
  readonly rangeId: bigint;
  readonly call: RangeCall;
}

/**
 * Two ranges over one store, split at the key `m`, each its own one-voter
 * Raft group. Range 2 can be marked remote: then this "node" holds no
 * replica of it and `forward` answers from a stand-in node that does.
 */
let ticks = 0n;
const START_MS = 1_760_000_000_000;

export async function twoRanges(
  options: {
    remoteRange2?: boolean;
    refuseFirstForward?: boolean;
    movedAway?: boolean;
    txn?: boolean;
  } = {},
) {
  const clock = new ManualClock(1_760_000_000_000n);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const registry = createKvRegistry();
  const handlers = new ApplyHandlerRegistry();
  const guard = options.txn ? lockGuard : undefined;
  for (const h of [
    kvWriteHandler(registry, guard),
    kvBatchHandler(registry, guard),
    expireHandler,
    gcThresholdHandler,
    ...(options.txn
      ? [
          txnPrewriteHandler(registry),
          txnCommitHandler(registry),
          txnRollbackHandler,
          txnCheckHandler,
        ]
      : []),
  ])
    handlers.register(h);
  const store = new MemoryStore();
  const events = new InMemoryEventBus({ logger, metrics });
  const split = headerKey('default', encoder.encode('m'));
  const spans = [
    create(RangeDescriptorSchema, { rangeId: 1n, endKey: split }),
    create(RangeDescriptorSchema, { rangeId: 2n, startKey: split }),
  ];
  const targets = new Map<bigint, RangeTarget>();
  for (const span of spans) {
    const machine = await StateMachine.open({
      store,
      handlers,
      rangeHooks: [kvRangeHooks, txnRangeHooks],
      events,
      clock,
      logger,
      metrics,
      rangeId: span.rangeId,
      descriptor: span,
    });
    const replica = await startSingleNode({
      log: new RaftLogStore(new MemoryStore(), span.rangeId),
      machine,
      clock,
      logger,
      metrics,
      rangeId: span.rangeId,
    });
    targets.set(span.rangeId, {
      rangeId: span.rangeId,
      proposer: replica,
      readBarrier: replica,
      reader: new SpanReader(store, span),
      state: store,
      descriptor: () => span,
      owns: (tenant, key) => options.movedAway !== true && inSpan(span, headerKey(tenant, key)),
    });
  }
  const forwarded: Forwarded[] = [];
  const rangeOf = (key: Uint8Array): bigint =>
    compareBytes(headerKey('default', key), split) < 0 ? 1n : 2n;
  const remote = (id: bigint) => options.remoteRange2 === true && id === 2n;
  const placement = (id: bigint): Placement => {
    const local = targets.get(id);
    return remote(id) || !local ? { rangeId: id } : { rangeId: id, local };
  };
  const ref: { service?: KvService } = {};
  const router: RangeRouter = {
    place: (_tenant, keys) => Promise.resolve(ok(keys.map((k) => placement(rangeOf(k))))),
    refresh: (p) => Promise.resolve(ok(p)),
    forward: async (p, caller, call) => {
      forwarded.push({ rangeId: p.rangeId, call });
      // The first forward is refused as if the leader had just moved.
      if (options.refuseFirstForward && forwarded.length === 1)
        return err(mindlogError('NOT_LEADER', 'moved'));
      // The stand-in node that holds range 2 runs the call on its own replica.
      const reply = await ref.service?.forwarded(p.rangeId, caller, call);
      return reply ? ok(reply) : err(mindlogError('UNAVAILABLE', 'no service'));
    },
    ranges: () => Promise.resolve(ok([placement(1n), placement(2n)])),
    local: (id) => (remote(id) ? undefined : targets.get(id)),
    any: () => targets.get(1n),
  };
  // For the forwarded path the stand-in uses a router that does hold range 2.
  const holder: RangeRouter = { ...router, local: (id) => targets.get(id) };
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, new SeededRandom(1n)),
  );
  const deps = {
    registry,
    store,
    proposer: (targets.get(1n) as RangeTarget).proposer,
    readBarrier: (targets.get(1n) as RangeTarget).readBarrier,
    stamper,
    clock,
    authenticator: new StaticAuthenticator(undefined),
    metrics,
    tracer: new OtelTracer(),
    ...(options.txn
      ? {
          tso: () => {
            ticks++;
            return Promise.resolve(ok((BigInt(START_MS) + ticks) << 16n));
          },
        }
      : {}),
  };
  const service = new KvService({ ...deps, router: options.remoteRange2 ? holder : router });
  ref.service = service;
  const front = options.remoteRange2 ? new KvService({ ...deps, router }) : service;
  const session = front.openSession('c');
  const run = async (...args: string[]) =>
    plain(
      await front.execute(
        session,
        args.map((a) => encoder.encode(a)),
      ),
    );
  return { run, forwarded, store, clock };
}
