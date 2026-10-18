import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  SeededRandom,
  UlidGenerator,
  packHlc,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvRangeHooks,
  kvWriteHandler,
} from '@mindlog/kv';
import { startSingleNode } from '@mindlog/multiraft';
import type { CommandResult } from '@mindlog/proto';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
  wholeKeyspace,
} from '@mindlog/statemachine';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import {
  lockGuard,
  txnCheckHandler,
  txnCommitHandler,
  txnPrewriteHandler,
  txnRangeHooks,
  txnRollbackHandler,
} from '@mindlog/txn';

type Body = Parameters<CommandStamper['stamp']>[2];
const START = 1_760_000_000_000n;
export const enc = new TextEncoder();
export const b = (s: string): Uint8Array => enc.encode(s);
/** A timestamp `ms` after the start, as the TSO would hand out. */
export const ts = (ms: number, logical = 0n): bigint => packHlc(START + BigInt(ms), logical);

/** A one-voter range with the KV and transaction handlers over memory stores. */
export async function txnNode() {
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
  const machine = await StateMachine.open({
    store,
    handlers,
    rangeHooks: [kvRangeHooks, txnRangeHooks],
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
    const proposed = await replica.propose(stamper.stamp('default', 'test', body));
    if (!proposed.ok) throw new Error(proposed.error.message);
    return proposed.value.result;
  };
  return { clock, store, replica, propose, reader: new MvccReader(store), registry };
}
