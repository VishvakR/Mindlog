import { create } from '@bufbuild/protobuf';
import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
  err,
  mindlogError,
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
import type { Replica } from '@mindlog/multiraft';
import { startSingleNode } from '@mindlog/multiraft';
import { RangeDescriptorSchema, TxnOutcomeSchema, TxnStatus } from '@mindlog/proto';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  inSpan,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';
import type { TxnCluster, TxnOp } from '@mindlog/txn';
import {
  TxnCoordinator,
  lockGuard,
  snapshotRead,
  txnCheckHandler,
  txnCommitHandler,
  txnPrewriteHandler,
  txnRangeHooks,
  txnRollbackHandler,
} from '@mindlog/txn';

export const b = (s: string): Uint8Array => new TextEncoder().encode(s);
const START = 1_760_000_000_000n;

/** Two one-voter ranges split at "m" over one store, and a coordinator that reaches both. */
export async function twoRanges() {
  const clock = new ManualClock(START);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const registry = createKvRegistry();
  const handlers = new ApplyHandlerRegistry();
  for (const h of [
    kvWriteHandler(registry, lockGuard),
    kvBatchHandler(registry, lockGuard),
    expireHandler,
    gcThresholdHandler,
    txnPrewriteHandler(registry),
    txnCommitHandler(registry),
    txnRollbackHandler,
    txnCheckHandler,
  ])
    handlers.register(h);
  const store = new MemoryStore();
  const events = new InMemoryEventBus({ logger, metrics });
  const split = headerKey('default', b('m'));
  const spans = [
    create(RangeDescriptorSchema, { rangeId: 1n, endKey: split }),
    create(RangeDescriptorSchema, { rangeId: 2n, startKey: split }),
  ];
  const replicas = new Map<bigint, Replica>();
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
    replicas.set(
      span.rangeId,
      await startSingleNode({
        log: new RaftLogStore(new MemoryStore(), span.rangeId),
        machine,
        clock,
        logger,
        metrics,
        rangeId: span.rangeId,
      }),
    );
  }
  const stamper = new CommandStamper(
    new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
    new UlidGenerator(clock, new SeededRandom(1n)),
  );
  const rangeOf = (tenant: string, key: Uint8Array): Replica => {
    const header = headerKey(tenant, key);
    for (const r of replicas.values()) if (inSpan(r.descriptor, header)) return r;
    throw new Error('no range');
  };
  const cluster: TxnCluster = {
    tso: () => {
      // The clock is virtual: time moves one millisecond per timestamp.
      clock.advance(1n);
      return Promise.resolve(ok(((START + BigInt(++ticks)) << 16n) | 0n));
    },
    place: (tenant, keys) => Promise.resolve(ok(keys.map((k) => rangeOf(tenant, k).rangeId))),
    run: async (tenant, probe, op: TxnOp) => {
      const replica = rangeOf(tenant, probe);
      if (op.kind === 'read') {
        const ready = await replica.read('linearizable');
        if (!ready.ok) return ready;
        return snapshotRead(
          { registry, state: store, descriptor: replica.descriptor, tenant },
          op.argv,
          op.ts,
        );
      }
      const body = { case: bodyCase[op.kind], value: op.body } as Parameters<
        CommandStamper['stamp']
      >[2];
      const proposed = await replica.propose(stamper.stamp(tenant, 'test', body));
      if (!proposed.ok) return proposed;
      const outcome = proposed.value.result.outcome;
      if (outcome.case === 'txn') return ok(outcome.value);
      return err(mindlogError('INTERNAL', 'not a transaction result'));
    },
  };
  let ticks = 0;
  const coordinator = new TxnCoordinator({
    cluster,
    keysOf: (argv) => registry.keysOf(argv),
    sleep: (ms) => {
      clock.advance(BigInt(ms));
      return Promise.resolve();
    },
  });
  const read = async (key: string) => {
    const r = await cluster.run('default', b(key), {
      kind: 'read',
      ts: ((START + BigInt(ticks + 1_000_000)) << 16n) | 0n,
      argv: [b('GET'), b(key)],
    });
    const reply = r.ok ? r.value.replies[0] : undefined;
    return reply?.kind.case === 'bulk' ? new TextDecoder().decode(reply.kind.value) : null;
  };
  return {
    coordinator,
    cluster,
    replicas,
    clock,
    stamper,
    read,
    registry,
    store,
    TxnOutcomeSchema,
    TxnStatus,
  };
}

const bodyCase = {
  prewrite: 'txnPrewrite',
  commit: 'txnCommit',
  rollback: 'txnRollback',
  check: 'txnCheck',
} as const;
