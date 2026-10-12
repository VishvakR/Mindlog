import { describe, expect, test } from 'vitest';
import { helloCommand, quitCommand, resetCommand, selectCommand } from '@mindlog/adapter-resp';
import { openClient, respServer } from '../support/resp-node.js';

const server = (password?: string) =>
  respServer({
    handlers: [helloCommand, selectCommand, quitCommand, resetCommand],
    ...(password ? { password } : {}),
  });

describe('SELECT', () => {
  test('only database 0 exists', async () => {
    const c = openClient(await server());
    expect(await c.send(['SELECT', '0'])).toBe('+OK\r\n');
    expect(await c.send(['SELECT', '1'])).toBe('-ERR DB index is out of range\r\n');
    expect(await c.send(['SELECT', 'x'])).toBe('-ERR value is not an integer or out of range\r\n');
  });
});

describe('QUIT', () => {
  test('replies OK, closes, and ignores the rest of the pipeline', async () => {
    const c = openClient(await server());
    expect(await c.send(['PING'], ['QUIT'], ['SET', 'a', '1'])).toBe('+PONG\r\n+OK\r\n');
    expect(c.isClosed()).toBe(true);
  });

  test('works before authentication and inside MULTI', async () => {
    const c = openClient(await server('pw'));
    expect(await c.send(['QUIT'])).toBe('+OK\r\n');
    const d = openClient(await server());
    expect(await d.send(['MULTI'], ['QUIT'])).toBe('+OK\r\n+OK\r\n');
    expect(d.isClosed()).toBe(true);
  });
});

describe('RESET', () => {
  test('clears MULTI, WATCH, protocol and authentication', async () => {
    const c = openClient(await server('pw'));
    await c.send(['AUTH', 'pw'], ['HELLO', '3'], ['WATCH', 'k'], ['MULTI'], ['SET', 'k', 'v']);
    expect(c.connection.session.transaction).toBeDefined();
    expect(await c.send(['RESET'])).toBe('+RESET\r\n');
    expect(c.client.protocol).toBe(2);
    expect(c.client.multi).toBe(-1);
    expect(c.connection.session.transaction).toBeUndefined();
    expect(c.connection.session.watches.size).toBe(0);
    expect(c.connection.session.authenticated).toBe(false);
    expect(await c.send(['GET', 'k'])).toBe('-NOAUTH Authentication required.\r\n');
  });
});

describe('preauthenticated connections', () => {
  test('skip AUTH and stay authenticated across RESET', async () => {
    const c = openClient(await server('pw'), undefined, 'admin@example.com');
    expect(await c.send(['SET', 'k', 'v'])).toBe('+OK\r\n');
    expect(c.connection.session.principal).toBe('admin@example.com');
    expect(await c.send(['RESET'], ['GET', 'k'])).toBe('+RESET\r\n$1\r\nv\r\n');
    expect(c.connection.session.authenticated).toBe(true);
  });
});
