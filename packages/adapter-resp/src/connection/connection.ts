import { replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { Session } from '@mindlog/services';
import { commandName } from '@mindlog/services';
import type { ParserLimits } from '../protocol/resp-parser.js';
import { RespParser } from '../protocol/resp-parser.js';
import { RespWriter } from '../protocol/resp-writer.js';
import type { ClientState } from './client-state.js';
import type {
  ConnectionCommandRegistry,
  ConnectionContext,
  ServerContext,
} from './connection-command.js';

/** The byte stream under a connection (a `net.Socket` in production). */
export interface ConnectionTransport {
  write(bytes: Buffer): void;
  /** Bytes written but not yet sent to the peer. */
  readonly pendingBytes: number;
  /** Stops and restarts reading from the peer (backpressure). */
  pause(): void;
  resume(): void;
  close(): void;
}

export interface ConnectionLimits {
  readonly parser: ParserLimits;
  /** Hard limit on unsent reply bytes; the client is disconnected above it. */
  readonly outputBufferBytes: number;
  /** Parsed commands waiting to run before reading pauses. */
  readonly maxPipeline: number;
}

/** Why a connection closed, for the disconnect metric and logs. */
export type CloseReason = 'quit' | 'protocol-error' | 'output-limit' | 'peer' | 'server';

export interface ConnectionDeps {
  readonly server: ServerContext;
  readonly handlers: ConnectionCommandRegistry;
  readonly transport: ConnectionTransport;
  readonly client: ClientState;
  readonly limits: ConnectionLimits;
  readonly onClose?: (reason: CloseReason) => void;
}

/** Replies are flushed at least this often within one pipeline. */
const FLUSH_BYTES = 64 * 1024;

/** Commands RESET and QUIT may run inside MULTI; other adapter commands may not. */
const ALLOWED_IN_MULTI = new Set(['QUIT', 'RESET']);

/**
 * One client connection: parses requests, runs them strictly in order
 * (pipelining), and writes each pipeline's replies in as few socket writes as
 * possible. Connection commands run here; everything else goes to KvService.
 */
export class Connection implements ConnectionContext {
  readonly server: ServerContext;
  readonly client: ClientState;
  readonly #deps: ConnectionDeps;
  readonly #parser: RespParser;
  readonly #writer = new RespWriter();
  #session: Session;
  #queue: Uint8Array[][] = [];
  #head = 0;
  #protocolError: string | undefined;
  /** Set while `#process` runs; cleared synchronously when it returns. */
  #processing = false;
  #running: Promise<void> = Promise.resolve();
  #closeAfterReply: CloseReason | undefined;
  #closed = false;
  #paused = false;

  constructor(deps: ConnectionDeps) {
    this.#deps = deps;
    this.server = deps.server;
    this.client = deps.client;
    this.#parser = new RespParser(deps.limits.parser);
    this.#session = deps.server.service.openSession(String(deps.client.id));
  }

  get session(): Session {
    return this.#session;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Feeds bytes from the peer. */
  receive(chunk: Buffer): void {
    if (this.#closed || this.#protocolError !== undefined) return;
    for (const event of this.#parser.push(chunk)) {
      if (event.kind === 'error') {
        this.#protocolError = event.message;
        break;
      }
      this.#queue.push(event.argv);
    }
    if (!this.#paused && this.#queue.length - this.#head > this.#deps.limits.maxPipeline) {
      this.#paused = true;
      this.#deps.transport.pause();
    }
    if (!this.#processing) {
      this.#processing = true;
      this.#running = this.#process();
    }
  }

  /** Resolves once every received command has been answered. */
  async idle(): Promise<void> {
    while (this.#processing) await this.#running;
  }

  /** Closes the connection; safe to call more than once. */
  close(reason: CloseReason = 'server'): void {
    if (this.#closed) return;
    this.#closed = true;
    this.server.clients.remove(this.client.id);
    this.#deps.transport.close();
    this.#deps.onClose?.(reason);
  }

  closeAfterReply(): void {
    this.#closeAfterReply = 'quit';
  }

  resetSession(): void {
    this.#session = this.server.service.openSession(String(this.client.id));
    this.client.protocol = 2;
    this.client.multi = -1;
  }

  async #process(): Promise<void> {
    while (this.#head < this.#queue.length && !this.#closed && !this.#closeAfterReply) {
      const argv = this.#queue[this.#head++] ?? [];
      const reply = await this.#run(argv);
      this.#writer.write(reply, this.client.protocol);
      if (this.#writer.length >= FLUSH_BYTES) this.#flush();
    }
    this.#queue = this.#queue.slice(this.#head);
    this.#head = 0;
    if (this.#protocolError !== undefined && this.#queue.length === 0) {
      this.#writer.writeError('INVALID_ARGUMENT', this.#protocolError);
      this.#closeAfterReply = 'protocol-error';
    }
    this.#flush();
    if (this.#closeAfterReply) this.close(this.#closeAfterReply);
    if (this.#paused && !this.#closed) {
      this.#paused = false;
      this.#deps.transport.resume();
    }
    this.#processing = false;
  }

  /** Sends buffered replies; a client that stopped reading is disconnected. */
  #flush(): void {
    if (this.#writer.length === 0 || this.#closed) return;
    const transport = this.#deps.transport;
    transport.write(this.#writer.take());
    if (transport.pendingBytes > this.#deps.limits.outputBufferBytes) {
      this.server.logger.warn('client output buffer limit reached; disconnecting', {
        clientId: this.client.id,
        pendingBytes: transport.pendingBytes,
      });
      this.close('output-limit');
    }
  }

  async #run(argv: readonly Uint8Array[]): Promise<KvReply> {
    const name = commandName(argv);
    this.client.lastCommand = name.toLowerCase() || 'NULL';
    this.client.lastActiveMs = this.server.clock.now();
    try {
      return await this.#dispatch(name, argv);
    } catch (cause) {
      this.server.logger.error('RESP command failed', { command: name, cause });
      return replies.error('INTERNAL', 'internal error');
    } finally {
      const transaction = this.#session.transaction;
      this.client.multi = transaction ? transaction.queued.length : -1;
    }
  }

  async #dispatch(name: string, argv: readonly Uint8Array[]): Promise<KvReply> {
    const handler = this.#deps.handlers.get(name);
    if (!handler) return this.server.service.execute(this.#session, argv);
    const spec = this.server.commands.get(name);
    if (!this.#session.authenticated && !spec?.command_flags.includes('NO_AUTH')) {
      return replies.error('UNAUTHENTICATED', 'Authentication required.');
    }
    if (spec && !(spec.arity >= 0 ? argv.length === spec.arity : argv.length >= -spec.arity)) {
      return replies.errors.arity(name);
    }
    const transaction = this.#session.transaction;
    if (transaction && !ALLOWED_IN_MULTI.has(name)) {
      transaction.failed = true;
      return replies.error('INVALID_ARGUMENT', 'Command not allowed inside a transaction');
    }
    return handler.execute(this, argv);
  }
}
