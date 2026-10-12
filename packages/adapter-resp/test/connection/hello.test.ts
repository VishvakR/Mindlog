import { describe, expect, test } from 'vitest';
import { helloCommand } from '@mindlog/adapter-resp';
import { openClient, respServer } from '../support/resp-node.js';

const server = (password?: string) =>
  respServer({ handlers: [helloCommand], ...(password ? { password } : {}) });

describe('HELLO', () => {
  test('HELLO 3 switches to RESP3 and replies with a map', async () => {
    const c = openClient(await server());
    const out = await c.send(['HELLO', '3']);
    expect(out).toMatch(/^%7\r\n\$6\r\nserver\r\n\$7\r\nmindlog\r\n/);
    expect(out).toContain('$5\r\nproto\r\n:3\r\n');
    expect(out).toContain(`$2\r\nid\r\n:${String(c.client.id)}\r\n`);
    expect(c.client.protocol).toBe(3);
    expect(await c.send(['GET', 'missing'])).toBe('_\r\n');
  });

  test('HELLO without arguments keeps the protocol; HELLO 2 downgrades', async () => {
    const c = openClient(await server());
    expect(await c.send(['HELLO'])).toMatch(/^\*14\r\n/);
    await c.send(['HELLO', '3']);
    expect(await c.send(['HELLO', '2'])).toMatch(/^\*14\r\n/);
    expect(await c.send(['GET', 'missing'])).toBe('$-1\r\n');
  });

  test('unsupported or malformed versions', async () => {
    const c = openClient(await server());
    expect(await c.send(['HELLO', '4'])).toBe('-NOPROTO unsupported protocol version\r\n');
    expect(await c.send(['HELLO', 'x'])).toBe(
      '-ERR Protocol version is not an integer or out of range\r\n',
    );
    expect(await c.send(['HELLO', '3', 'BOGUS'])).toBe(
      "-ERR Syntax error in HELLO option 'BOGUS'\r\n",
    );
    expect(await c.send(['HELLO', '3', 'AUTH', 'default'])).toBe(
      "-ERR Syntax error in HELLO option 'AUTH'\r\n",
    );
    expect(c.client.protocol).toBe(2);
  });

  test('AUTH and SETNAME options', async () => {
    const c = openClient(await server('pw'));
    expect(await c.send(['HELLO', '3'])).toMatch(
      /^-NOAUTH HELLO must be called with the client already authenticated/,
    );
    expect(await c.send(['HELLO', '3', 'AUTH', 'default', 'bad'])).toBe(
      '-WRONGPASS invalid username-password pair or user is disabled.\r\n',
    );
    expect(c.client.protocol).toBe(2);
    expect(await c.send(['HELLO', '3', 'AUTH', 'default', 'pw', 'SETNAME', 'app'])).toMatch(/^%7/);
    expect(c.connection.session.authenticated).toBe(true);
    expect(c.client.name).toBe('app');
  });

  test('without a password, HELLO AUTH default <anything> succeeds', async () => {
    const c = openClient(await server());
    expect(await c.send(['HELLO', '3', 'AUTH', 'default', 'whatever'])).toMatch(/^%7/);
  });

  test('invalid client names are rejected', async () => {
    const c = openClient(await server());
    expect(await c.send(['HELLO', '3', 'SETNAME', 'a b'])).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect(c.client.protocol).toBe(2);
  });
});
