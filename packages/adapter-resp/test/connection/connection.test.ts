import { describe, expect, test } from 'vitest';
import { openClient, respServer } from '../support/resp-node.js';

describe('Connection', () => {
  test('runs KV commands through the service', async () => {
    const c = openClient(await respServer());
    expect(await c.send(['SET', 'k', 'v'])).toBe('+OK\r\n');
    expect(await c.send(['GET', 'k'])).toBe('$1\r\nv\r\n');
    expect(await c.raw('PING\r\n')).toBe('+PONG\r\n');
  });

  test('pipelined replies keep request order and leave in one write', async () => {
    const c = openClient(await respServer());
    const out = await c.send(['INCR', 'n'], ['GET', 'missing'], ['INCR', 'n'], ['ECHO', 'x']);
    expect(out).toBe(':1\r\n$-1\r\n:2\r\n$1\r\nx\r\n');
  });

  test('requests split across many chunks', async () => {
    const c = openClient(await respServer());
    const bytes = Buffer.from(
      '*3\r\n$3\r\nSET\r\n$1\r\na\r\n$2\r\nhi\r\n*2\r\n$3\r\nGET\r\n$1\r\na\r\n',
    );
    for (let i = 0; i < bytes.length; i++) c.connection.receive(bytes.subarray(i, i + 1));
    await c.connection.idle();
    expect(Buffer.concat(c.writes).toString('latin1')).toBe('+OK\r\n$2\r\nhi\r\n');
  });

  test('a protocol error is answered after earlier commands, then the connection closes', async () => {
    const c = openClient(await respServer());
    const out = await c.raw('PING\r\n*1\r\n+bad\r\nPING\r\n');
    expect(out).toBe("+PONG\r\n-ERR Protocol error: expected '$', got '+'\r\n");
    expect(c.isClosed()).toBe(true);
    expect(c.connection.closed).toBe(true);
    expect(await c.raw('PING\r\n')).toBe('');
  });

  test('connection commands are answered by the adapter', async () => {
    const c = openClient(await respServer());
    expect(await c.send(['COMMAND', 'COUNT'])).toMatch(/^:\d+\r\n$/);
    expect(await c.send(['COMMAND', 'COUNT', 'extra'])).toBe(
      "-ERR wrong number of arguments for 'command|count' command\r\n",
    );
  });

  test('connection commands need authentication unless flagged NO_AUTH', async () => {
    const c = openClient(await respServer({ password: 'secret' }));
    expect(await c.send(['COMMAND', 'COUNT'])).toBe('-NOAUTH Authentication required.\r\n');
    expect(await c.send(['AUTH', 'secret'], ['COMMAND', 'COUNT'])).toMatch(/^\+OK\r\n:\d+\r\n$/);
  });

  test('connection commands inside MULTI abort the transaction', async () => {
    const c = openClient(await respServer());
    const out = await c.send(['MULTI'], ['SET', 'a', '1'], ['COMMAND'], ['EXEC']);
    expect(out).toBe(
      '+OK\r\n+QUEUED\r\n-ERR Command not allowed inside a transaction\r\n-EXECABORT Transaction discarded because of previous errors.\r\n',
    );
  });

  test('tracks the last command and MULTI depth for CLIENT LIST', async () => {
    const c = openClient(await respServer());
    await c.send(['MULTI'], ['SET', 'a', '1']);
    expect(c.client.multi).toBe(1);
    expect(c.client.lastCommand).toBe('set');
    await c.send(['DISCARD']);
    expect(c.client.multi).toBe(-1);
  });

  test('a failing handler becomes an internal error, and the connection survives', async () => {
    const fixture = await respServer({
      handlers: [
        {
          name: 'CLIENT',
          execute: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    const c = openClient(fixture);
    expect(await c.send(['CLIENT', 'ID'], ['PING'])).toBe('-ERR internal error\r\n+PONG\r\n');
    expect(fixture.logger.entries.some((e) => e.message === 'RESP command failed')).toBe(true);
  });

  test('closing removes the client from the registry', async () => {
    const fixture = await respServer();
    const c = openClient(fixture);
    expect(fixture.server.clients.size).toBe(1);
    c.connection.close();
    c.connection.close();
    expect(fixture.server.clients.size).toBe(0);
  });
});
