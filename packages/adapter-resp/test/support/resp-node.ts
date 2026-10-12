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
import { KvService, StaticAuthenticator } from '@mindlog/services';
import {
  ApplyHandlerRegistry,
  CommandStamper,
  LocalLog,
  LocalProposer,
  StateMachine,
} from '@mindlog/statemachine';
import { MemoryStore } from '@mindlog/storage';
import type {
  CloseReason,
  ConnectionCommand,
  ConnectionLimits,
  ServerContext,
} from '@mindlog/adapter-resp';
import {
  ClientRegistry,
  CommandTable,
  Connection,
  ConnectionCommandRegistry,
  DEFAULT_LIMITS,
  commandCommand,
  loadCommandSpecs,
} from '@mindlog/adapter-resp';

const specs = loadCommandSpecs();

/** A KvService over in-memory stores, as the server wires it. */
export async function respServer(
  options: { password?: string; handlers?: readonly ConnectionCommand[] } = {},
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
  const proposer = new LocalProposer({
    log: await LocalLog.open(new MemoryStore()),
    machine,
    logger,
    metrics,
  });
  const service = new KvService({
    registry,
    store,
    proposer,
    stamper: new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, new SeededRandom(1n)),
    ),
    clock,
    authenticator: new StaticAuthenticator(options.password),
    metrics,
    tracer: new OtelTracer(),
  });
  const server: ServerContext = {
    service,
    commands: new CommandTable(specs),
    clients: new ClientRegistry(),
    clock,
    logger,
    info: {
      redisVersion: '7.2.0',
      mindlogVersion: '0.0.0',
      port: 6379,
      startedAtMs: clock.now(),
      processId: 4242,
      settings: { databases: '1', maxclients: '10000' },
    },
  };
  const connectionHandlers = new ConnectionCommandRegistry([
    commandCommand,
    ...(options.handlers ?? []),
  ]);
  return { clock, logger, metrics, service, server, handlers: connectionHandlers };
}

export type RespServerFixture = Awaited<ReturnType<typeof respServer>>;

export const TEST_LIMITS: ConnectionLimits = {
  parser: DEFAULT_LIMITS,
  outputBufferBytes: 64 * 1024 * 1024,
  maxPipeline: 1024,
};

/** A connection whose transport records what the server sends. */
export function openClient(
  fixture: RespServerFixture,
  limits: ConnectionLimits = TEST_LIMITS,
  principal?: string,
) {
  const writes: Buffer[] = [];
  const transport = {
    /** While set, written bytes stay pending, as with a peer that stopped reading. */
    stalled: false,
    pendingBytes: 0,
    paused: false,
    pauses: 0,
    closeReason: undefined as CloseReason | undefined,
  };
  let closed = false;
  const client = fixture.server.clients.register(
    '127.0.0.1:50000',
    '127.0.0.1:6379',
    fixture.clock.now(),
  );
  const connection = new Connection({
    server: fixture.server,
    handlers: fixture.handlers,
    client,
    limits,
    transport: {
      write: (bytes) => {
        writes.push(bytes);
        if (transport.stalled) transport.pendingBytes += bytes.length;
      },
      get pendingBytes() {
        return transport.pendingBytes;
      },
      pause: () => {
        transport.paused = true;
        transport.pauses++;
      },
      resume: () => {
        transport.paused = false;
      },
      close: () => {
        closed = true;
      },
    },
    onClose: (reason) => {
      transport.closeReason = reason;
    },
    ...(principal === undefined ? {} : { principal }),
  });
  /** Sends raw bytes and returns everything written in reply. */
  const raw = async (bytes: string | Buffer): Promise<string> => {
    connection.receive(typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes);
    await connection.idle();
    return Buffer.concat(writes.splice(0)).toString('latin1');
  };
  /** Sends commands as one pipeline of multibulk frames. */
  const send = (...commands: string[][]): Promise<string> =>
    raw(Buffer.concat(commands.map(frame)));
  return { connection, client, writes, transport, raw, send, isClosed: () => closed };
}

export function frame(args: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from(`*${String(args.length)}\r\n`),
    ...args.flatMap((a) => {
      const b = Buffer.from(a);
      return [Buffer.from(`$${String(b.length)}\r\n`), b, Buffer.from('\r\n')];
    }),
  ]);
}
