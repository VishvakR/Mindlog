import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
import { Connection } from '@mindlog/adapter-resp';
import type { HttpServerDeps } from '../http-deps.js';

/** Subprotocol the console speaks: raw RESP frames in binary WebSocket messages. */
export const CONSOLE_PROTOCOL = 'mindlog.resp';

const toBuffer = (data: RawData): Buffer =>
  Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

/**
 * `GET /api/console`: proxies RESP over a WebSocket into a regular RESP
 * `Connection`, preauthenticated as the superuser, so every command, HELLO and
 * MULTI included, behaves as it does over TCP (PLAN 17.2 console).
 */
export function consoleRoutes(app: FastifyInstance, deps: HttpServerDeps): void {
  app.get('/api/console', { websocket: true }, (socket, request) => {
    const { server, handlers, limits } = deps.resp;
    const client = server.clients.register(
      `${request.ip}:${String(request.socket.remotePort ?? 0)}`,
      `${request.socket.localAddress ?? '?'}:${String(request.socket.localPort ?? 0)}`,
      deps.clock.now(),
    );
    client.name = 'dashboard-console';
    const connection = new Connection({
      server,
      handlers,
      client,
      limits,
      principal: request.superuser?.email ?? 'anonymous',
      transport: {
        write: (bytes) => {
          socket.send(bytes, { binary: true });
        },
        get pendingBytes() {
          return socket.bufferedAmount;
        },
        pause: () => {
          socket.pause();
        },
        resume: () => {
          socket.resume();
        },
        close: () => {
          socket.close();
        },
      },
    });
    socket.on('message', (data) => {
      connection.receive(toBuffer(data));
    });
    socket.on('close', () => {
      connection.close('peer');
    });
  });
}
