import type { AddressInfo, Server, Socket } from 'node:net';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import type { Counter, Gauge, MindlogError, Metrics, Result, TlsProvider } from '@mindlog/core';
import { err, mindlogError, ok, publicServerTls } from '@mindlog/core';
import type { ConnectionCommandRegistry, ServerContext } from '../connection/connection-command.js';
import type { CloseReason, ConnectionLimits } from '../connection/connection.js';
import { Connection } from '../connection/connection.js';

export interface RespServerOptions {
  readonly host: string;
  /** 0 picks a free port. */
  readonly port: number;
  readonly maxClients: number;
  /** Closes connections idle this long; 0 disables. */
  readonly idleTimeoutMs: number;
  readonly limits: ConnectionLimits;
}

export interface RespServerDeps {
  readonly context: ServerContext;
  readonly handlers: ConnectionCommandRegistry;
  readonly metrics: Metrics;
  readonly options: RespServerOptions;
  /** Serves TLS; rotated certificates apply to new connections. */
  readonly tls?: TlsProvider;
}

const MAX_CLIENTS_REPLY = Buffer.from('-ERR max number of clients reached\r\n');

const address = (host: string | undefined, port: number | undefined): string =>
  `${host ?? '?'}:${String(port ?? 0)}`;

/**
 * The RESP TCP listener: accepts sockets, enforces `maxClients` and the idle
 * timeout, bridges each socket to a `Connection`, and shuts down gracefully
 * (stop accepting, finish in-flight commands, close).
 */
export class RespServer {
  readonly #deps: RespServerDeps;
  readonly #server: Server;
  readonly #connections = new Set<Connection>();
  readonly #open: Gauge;
  readonly #accepted: Counter;
  readonly #rejected: Counter;
  readonly #disconnects: Counter;
  readonly #received: Counter;
  #stopTls: (() => void) | undefined;
  #closing = false;

  constructor(deps: RespServerDeps) {
    this.#deps = deps;
    const { metrics } = deps;
    this.#open = metrics.gauge({
      name: 'mindlog_resp_connections_count',
      help: 'Open RESP client connections',
    });
    this.#accepted = metrics.counter({
      name: 'mindlog_resp_connections_accepted_total',
      help: 'RESP connections accepted',
    });
    this.#rejected = metrics.counter({
      name: 'mindlog_resp_connections_rejected_total',
      help: 'RESP connections refused because maxClients was reached',
    });
    this.#disconnects = metrics.counter({
      name: 'mindlog_resp_disconnects_total',
      help: 'RESP connections closed, by reason',
      labelNames: ['reason'],
    });
    this.#received = metrics.counter({
      name: 'mindlog_resp_received_bytes_total',
      help: 'Bytes received from RESP clients',
    });
    const tls = deps.tls;
    const accept = (socket: Socket) => {
      socket.setNoDelay(true);
      this.#accept(socket);
    };
    if (tls) {
      const server = createTlsServer(publicServerTls(tls.identity()), accept);
      this.#stopTls = tls.subscribe((i) => {
        server.setSecureContext(publicServerTls(i));
      });
      this.#server = server;
    } else this.#server = createServer({ noDelay: true }, accept);
  }

  /** Starts listening; resolves with the bound address. */
  listen(): Promise<Result<AddressInfo, MindlogError>> {
    const { host, port } = this.#deps.options;
    return new Promise((resolve) => {
      const onError = (cause: Error) => {
        resolve(
          err(
            mindlogError(
              'UNAVAILABLE',
              `cannot listen on ${address(host, port)}: ${cause.message}`,
              { cause },
            ),
          ),
        );
      };
      this.#server.once('error', onError);
      this.#server.listen(port, host, () => {
        this.#server.off('error', onError);
        this.#server.on('error', (cause) => {
          this.#deps.context.logger.error('RESP listener error', { cause });
        });
        resolve(ok(this.#server.address() as AddressInfo));
      });
    });
  }

  get connections(): number {
    return this.#connections.size;
  }

  /** Stops accepting, lets in-flight commands finish, then closes every connection. */
  async close(): Promise<void> {
    this.#stopTls?.();
    this.#closing = true;
    const stopped = new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
    });
    await Promise.all(
      [...this.#connections].map(async (connection) => {
        await connection.idle();
        connection.close('server');
      }),
    );
    await stopped;
  }

  #accept(socket: Socket): void {
    const { context, options } = this.#deps;
    if (this.#closing || context.clients.size >= options.maxClients) {
      this.#rejected.inc();
      socket.end(MAX_CLIENTS_REPLY);
      return;
    }
    this.#accepted.inc();
    this.#open.inc();
    const client = context.clients.register(
      address(socket.remoteAddress, socket.remotePort),
      address(socket.localAddress, socket.localPort),
      context.clock.now(),
    );
    const connection = new Connection({
      server: context,
      handlers: this.#deps.handlers,
      client,
      limits: options.limits,
      transport: {
        write: (bytes) => socket.write(bytes),
        get pendingBytes() {
          return socket.writableLength;
        },
        pause: () => socket.pause(),
        resume: () => socket.resume(),
        close: () => socket.end(),
      },
      onClose: (reason: CloseReason) => {
        this.#disconnects.inc(1, { reason });
        if (reason === 'output-limit') socket.destroy();
      },
    });
    this.#connections.add(connection);
    if (options.idleTimeoutMs > 0) {
      socket.setTimeout(options.idleTimeoutMs, () => {
        connection.close('idle');
      });
    }
    socket.on('data', (chunk: Buffer) => {
      this.#received.inc(chunk.length);
      connection.receive(chunk);
    });
    socket.on('error', (cause) => {
      context.logger.debug('RESP socket error', { clientId: client.id, cause });
    });
    socket.on('close', () => {
      connection.close('peer');
      this.#connections.delete(connection);
      this.#open.dec();
    });
  }
}
