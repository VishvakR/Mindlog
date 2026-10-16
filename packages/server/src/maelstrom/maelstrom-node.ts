import type { Clock, Logger } from '@mindlog/core';
import { HybridLogicalClock, MemoryMetrics, SystemRandom, UlidGenerator } from '@mindlog/core';
import { InMemoryEventBus } from '@mindlog/eventbus';
import {
  createKvRegistry,
  expireHandler,
  gcThresholdHandler,
  kvBatchHandler,
  kvWriteHandler,
} from '@mindlog/kv';
import { DEFAULT_REPLICA_OPTIONS, Replica, SystemScheduler } from '@mindlog/multiraft';
import type { KvReply } from '@mindlog/proto';
import type { Session } from '@mindlog/services';
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  RaftLogStore,
  StateMachine,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';
import type { MaelstromSend } from './maelstrom-transport.js';
import { MaelstromTransport } from './maelstrom-transport.js';

/** Maelstrom error codes (doc/protocol.md): 11 definite, 13 indefinite, 22 precondition failed. */
const TEMPORARILY_UNAVAILABLE = 11;
const CRASH = 13;
const KEY_DOES_NOT_EXIST = 20;
const PRECONDITION_FAILED = 22;

type Body = Record<string, unknown>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * One Maelstrom `lin-kv` node: the real Raft replica and KV state machine
 * over in-memory stores. `read` is a lease/ReadIndex-checked GET, `write` a
 * SET and `cas` a `SET … IFEQ` (Valkey 8.1).
 */
export class MaelstromNode {
  readonly #transport: MaelstromTransport;
  readonly #service: KvService;
  readonly #session: Session;
  readonly replica: Replica;

  private constructor(transport: MaelstromTransport, replica: Replica, service: KvService) {
    this.#transport = transport;
    this.replica = replica;
    this.#service = service;
    this.#session = service.openSession('maelstrom');
  }

  static async start(
    nodeId: string,
    nodeIds: readonly string[],
    send: MaelstromSend,
    deps: { clock: Clock; logger: Logger },
  ): Promise<MaelstromNode> {
    const { clock, logger } = deps;
    const metrics = new MemoryMetrics();
    const registry = createKvRegistry();
    const handlers = new ApplyHandlerRegistry();
    for (const h of [
      kvWriteHandler(registry),
      kvBatchHandler(registry),
      expireHandler,
      gcThresholdHandler,
    ])
      handlers.register(h);
    const store = new MemoryStore();
    const machine = await StateMachine.open({
      store,
      handlers,
      events: new InMemoryEventBus({ logger, metrics }),
      clock,
      logger,
      metrics,
    });
    const transport = new MaelstromTransport(send);
    const replica = await Replica.open({
      rangeId: 1n,
      raftId: raftId(nodeId),
      options: DEFAULT_REPLICA_OPTIONS,
      log: new RaftLogStore(new MemoryStore()),
      machine,
      transport,
      scheduler: new SystemScheduler(),
      clock,
      random: new SystemRandom(),
      logger,
      metrics,
      bootstrap: nodeIds.map((id) => ({ id: raftId(id), address: id })),
    });
    replica.start();
    const service = new KvService({
      registry,
      store,
      proposer: replica,
      readBarrier: replica,
      stamper: new CommandStamper(
        new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
        new UlidGenerator(clock, new SystemRandom()),
      ),
      clock,
      authenticator: new StaticAuthenticator(undefined),
      metrics,
      tracer: { withSpan: (_name, _attrs, fn) => fn({ setAttribute: () => {} }) },
    });
    return new MaelstromNode(transport, replica, service);
  }

  /** Raft traffic from another node; returns false for anything else. */
  receive(body: Body): boolean {
    return this.#transport.receive(body);
  }

  /** Answers a lin-kv client request with the reply body. */
  async handle(body: Body): Promise<Body> {
    const key = JSON.stringify(body.key);
    switch (body.type) {
      case 'read': {
        const reply = await this.#run(['GET', key]);
        if (reply.kind.case === 'bulk')
          return { type: 'read_ok', value: JSON.parse(decoder.decode(reply.kind.value)) };
        if (reply.kind.case === 'null') return error(KEY_DOES_NOT_EXIST, 'key does not exist');
        return failure(reply, true);
      }
      case 'write': {
        const reply = await this.#run(['SET', key, JSON.stringify(body.value)]);
        return reply.kind.case === 'error' ? failure(reply, false) : { type: 'write_ok' };
      }
      case 'cas': {
        const reply = await this.#run([
          'SET',
          key,
          JSON.stringify(body.to),
          'IFEQ',
          JSON.stringify(body.from),
        ]);
        if (reply.kind.case === 'null') return error(PRECONDITION_FAILED, 'value does not match');
        return reply.kind.case === 'error' ? failure(reply, false) : { type: 'cas_ok' };
      }
      default:
        return error(10, `unsupported request ${String(body.type)}`);
    }
  }

  #run(argv: readonly string[]): Promise<KvReply> {
    return this.#service.execute(
      this.#session,
      argv.map((a) => encoder.encode(a)),
    );
  }
}

/** Maelstrom names nodes n0, n1, …; Raft ids must be non-zero (ADR-0006). */
function raftId(nodeId: string): bigint {
  if (!/^n\d+$/.test(nodeId)) throw new Error(`unexpected Maelstrom node id ${nodeId}`);
  return BigInt(nodeId.slice(1)) + 1n;
}

const error = (code: number, text: string): Body => ({ type: 'error', code, text });

/** Refused before proposing (or a read) is definite; anything else may still apply. */
function failure(reply: KvReply, read: boolean): Body {
  if (reply.kind.case !== 'error') return error(CRASH, 'unexpected reply');
  const { code, message } = reply.kind.value;
  const definite = read || code === 'NOT_LEADER' || code === 'BUSY';
  return error(definite ? TEMPORARILY_UNAVAILABLE : CRASH, `${code}: ${message}`);
}
