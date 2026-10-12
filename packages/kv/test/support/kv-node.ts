import { create } from '@bufbuild/protobuf';
import { ManualClock, MemoryLogger, MemoryMetrics, packHlc } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import type { KvCommandRegistry } from '@mindlog/kv';
import { KvReadExecutor, expireHandler, isWrite, kvWriteHandler } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import { CommandSchema } from '@mindlog/proto';
import { MemoryStore } from '@mindlog/storage';
import { ApplyHandlerRegistry, LocalLog, LocalProposer, StateMachine } from '@mindlog/statemachine';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Plain JS form of a reply, for readable assertions. */
export type Plain =
  string | number | null | boolean | { error: string } | Plain[] | { map: [Plain, Plain][] };

export function plain(reply: KvReply): Plain {
  const kind = reply.kind;
  switch (kind.case) {
    case 'null':
      return null;
    case 'integer':
      return Number(kind.value);
    case 'bulk':
      return decoder.decode(kind.value);
    case 'simple':
      return kind.value;
    case 'double':
      return kind.value;
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

/**
 * A single-node KV pipeline for tests: writes go through the proposer and
 * apply (with the clock's time in the HLC); reads run on applied state.
 */
export async function kvNode(registry: KvCommandRegistry, startMs = 1_760_000_000_000n) {
  const clock = new ManualClock(startMs);
  const logger = new MemoryLogger();
  const metrics = new MemoryMetrics();
  const handlers = new ApplyHandlerRegistry();
  handlers.register(kvWriteHandler(registry));
  handlers.register(expireHandler);
  const store = new MemoryStore();
  const machine = await StateMachine.open({
    store,
    handlers,
    events: new InMemoryEventBus({ logger, metrics }),
    clock,
    logger,
    metrics,
  });
  const proposer = new LocalProposer({
    log: await LocalLog.open(new MemoryStore()),
    machine,
    logger,
    metrics,
  });
  const reads = new KvReadExecutor(registry, store);
  let request = 0;

  async function raw(...args: (string | Uint8Array)[]): Promise<KvReply> {
    const argv = args.map((a) => (typeof a === 'string' ? encoder.encode(a) : a));
    const command = argv[0] ? registry.get(argv[0]) : undefined;
    if (command && !isWrite(command)) return reads.execute('t', argv, clock.now());
    const proposal = await proposer.propose(
      create(CommandSchema, {
        requestId: encoder.encode(`r${request++}`),
        tenant: 't',
        hlc: packHlc(clock.now(), 0n),
        body: { case: 'kvWrite', value: { argv } },
      }),
    );
    if (!proposal.ok) throw new Error(proposal.error.message);
    const outcome = proposal.value.result.outcome;
    if (outcome.case !== 'kv') throw new Error(`unexpected result ${outcome.case ?? 'none'}`);
    return outcome.value;
  }

  return {
    clock,
    store,
    proposer,
    logger,
    metrics,
    raw,
    run: async (...args: (string | Uint8Array)[]) => plain(await raw(...args)),
  };
}
