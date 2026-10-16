import {
  HybridLogicalClock,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  OtelTracer,
  SeededRandom,
  UlidGenerator,
} from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvWriteHandler,
} from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import type { Session } from '@mindlog/services';
import { startSingleNode } from '@mindlog/multiraft';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type Plain =
  string | number | null | boolean | { error: string } | Plain[] | { map: [Plain, Plain][] };

export function plain(reply: KvReply): Plain {
  const kind = reply.kind;
  switch (kind.case) {
    case 'integer':
      return Number(kind.value);
    case 'bulk':
      return decoder.decode(kind.value);
    case 'simple':
    case 'double':
    case 'boolean':
      return kind.value;
    case 'array':
    case 'set':
      return kind.value.items.map(plain);
    case 'map':
      return {
        map: kind.value.entries.map((e) => [plain(e.key ?? reply), plain(e.value ?? reply)]),
      };
    case 'error':
      return { error: `${kind.value.code} ${kind.value.message}` };
    default:
      return null;
  }
}

/** A full single-node service stack over in-memory stores. */
export async function serviceNode(
  options: { password?: string; maxQueue?: number; maxTransactionCommands?: number } = {},
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
  ]) {
    handlers.register(h);
  }
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
  });
  const proposer = await startSingleNode({
    log: new RaftLogStore(new MemoryStore()),
    machine,
    clock,
    logger,
    metrics,
    options: { maxPendingProposals: options.maxQueue ?? 10_000 },
  });
  const service = new KvService({
    registry,
    store,
    proposer,
    readBarrier: proposer,
    stamper: new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, new SeededRandom(1n)),
    ),
    clock,
    authenticator: new StaticAuthenticator(options.password),
    metrics,
    tracer: new OtelTracer(),
    ...(options.maxTransactionCommands === undefined
      ? {}
      : { maxTransactionCommands: options.maxTransactionCommands }),
  });
  let sessions = 0;
  const open = () => service.openSession(`c${sessions++}`);
  const run = async (session: Session, ...args: (string | Uint8Array)[]) =>
    plain(
      await service.execute(
        session,
        args.map((a) => (typeof a === 'string' ? encoder.encode(a) : a)),
      ),
    );
  return { clock, store, proposer, service, metrics, logger, open, run };
}
