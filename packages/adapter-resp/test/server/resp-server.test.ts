import type { Socket } from 'node:net';
import { connect } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { RespServer, createConnectionCommands } from '@mindlog/adapter-resp';
import type { RespServerOptions } from '@mindlog/adapter-resp';
import { TEST_LIMITS, frame, respServer } from '../support/resp-node.js';

const servers: RespServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function start(options: Partial<RespServerOptions> = {}) {
  const fixture = await respServer();
  const server = new RespServer({
    context: fixture.server,
    handlers: createConnectionCommands(),
    metrics: fixture.metrics,
    options: {
      host: '127.0.0.1',
      port: 0,
      maxClients: 100,
      idleTimeoutMs: 0,
      limits: TEST_LIMITS,
      ...options,
    },
  });
  servers.push(server);
  const bound = await server.listen();
  if (!bound.ok) throw new Error(bound.error.message);
  return { fixture, server, port: bound.value.port };
}

/** A raw TCP client that collects everything the server sends. */
async function client(port: number) {
  const socket: Socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve) =>
    socket.once('connect', () => {
      resolve();
    }),
  );
  let received = '';
  let closed = false;
  socket.on('data', (chunk: Buffer) => (received += chunk.toString('latin1')));
  socket.on('close', () => (closed = true));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 400 && !done(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  return {
    socket,
    /** Sends commands and waits until `expected` bytes have arrived. */
    async request(expected: number, ...commands: string[][]) {
      received = '';
      socket.write(Buffer.concat(commands.map(frame)));
      await until(() => received.length >= expected);
      return received;
    },
    received: () => received,
    closed: () => closed,
    until,
  };
}

describe('RespServer', () => {
  test('serves commands over TCP', async () => {
    const { port } = await start();
    const c = await client(port);
    expect(await c.request(5, ['SET', 'k', 'v'])).toBe('+OK\r\n');
    expect(await c.request(13, ['GET', 'k'], ['PING'])).toBe('$1\r\nv\r\n+PONG\r\n');
    c.socket.destroy();
  });

  test('a port in use is an UNAVAILABLE error', async () => {
    const { port } = await start();
    const fixture = await respServer();
    const second = new RespServer({
      context: fixture.server,
      handlers: createConnectionCommands(),
      metrics: fixture.metrics,
      options: { host: '127.0.0.1', port, maxClients: 1, idleTimeoutMs: 0, limits: TEST_LIMITS },
    });
    const bound = await second.listen();
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.error.code).toBe('UNAVAILABLE');
  });

  test('refuses clients beyond maxClients', async () => {
    const { port, fixture } = await start({ maxClients: 1 });
    const a = await client(port);
    await a.request(7, ['PING']);
    const b = await client(port);
    await b.until(() => b.closed());
    expect(b.received()).toBe('-ERR max number of clients reached\r\n');
    expect(fixture.metrics.value('mindlog_resp_connections_rejected_total')).toBe(1);
    a.socket.destroy();
  });

  test('closes idle connections', async () => {
    const { port, fixture } = await start({ idleTimeoutMs: 50 });
    const c = await client(port);
    await c.until(() => c.closed());
    expect(c.closed()).toBe(true);
    expect(fixture.metrics.value('mindlog_resp_disconnects_total', { reason: 'idle' })).toBe(1);
  });

  test('tracks open connections and peer disconnects', async () => {
    const { port, server, fixture } = await start();
    const c = await client(port);
    await c.request(7, ['PING']);
    expect(server.connections).toBe(1);
    expect(fixture.metrics.value('mindlog_resp_connections_count')).toBe(1);
    c.socket.destroy();
    await c.until(() => server.connections === 0);
    expect(fixture.metrics.value('mindlog_resp_connections_count')).toBe(0);
    expect(fixture.metrics.value('mindlog_resp_disconnects_total', { reason: 'peer' })).toBe(1);
    expect(fixture.metrics.value('mindlog_resp_received_bytes_total')).toBeGreaterThan(0);
  });

  test('close disconnects every client and stops accepting', async () => {
    const { port, server } = await start();
    const c = await client(port);
    expect(await c.request(8, ['INCR', 'n'], ['INCR', 'n'])).toBe(':1\r\n:2\r\n');
    await server.close();
    await c.until(() => c.closed());
    expect(c.closed()).toBe(true);
    const refused = await new Promise<string>((resolve) => {
      connect(port, '127.0.0.1')
        .on('error', (e: NodeJS.ErrnoException) => {
          resolve(e.code ?? '');
        })
        .on('connect', () => {
          resolve('connected');
        });
    });
    expect(refused).toBe('ECONNREFUSED');
    servers.pop();
  });
});
