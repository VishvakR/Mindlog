import { describe, expect, test } from 'vitest';
import { clientCommand } from '@mindlog/adapter-resp';
import { openClient, respServer } from '../support/resp-node.js';

describe('CLIENT', () => {
  test('ID, SETNAME and GETNAME', async () => {
    const c = openClient(await respServer({ handlers: [clientCommand] }));
    expect(await c.send(['CLIENT', 'ID'])).toBe(`:${String(c.client.id)}\r\n`);
    expect(await c.send(['CLIENT', 'GETNAME'])).toBe('$-1\r\n');
    expect(await c.send(['client', 'setname', 'worker-1'], ['CLIENT', 'GETNAME'])).toBe(
      '+OK\r\n$8\r\nworker-1\r\n',
    );
    expect(await c.send(['CLIENT', 'SETNAME', 'bad name'])).toBe(
      '-ERR Client names cannot contain spaces, newlines or special characters.\r\n',
    );
    expect(await c.send(['CLIENT', 'SETNAME', ''], ['CLIENT', 'GETNAME'])).toBe('+OK\r\n$-1\r\n');
  });

  test('SETINFO records the library as clients send it on connect', async () => {
    const c = openClient(await respServer({ handlers: [clientCommand] }));
    expect(
      await c.send(
        ['CLIENT', 'SETINFO', 'LIB-NAME', 'redis-py'],
        ['CLIENT', 'SETINFO', 'lib-ver', '5.2.1'],
      ),
    ).toBe('+OK\r\n+OK\r\n');
    expect(c.client.libName).toBe('redis-py');
    expect(c.client.libVersion).toBe('5.2.1');
    expect(await c.send(['CLIENT', 'SETINFO', 'LIB-COLOR', 'x'])).toBe(
      "-ERR Unrecognized option 'LIB-COLOR'\r\n",
    );
    expect(await c.send(['CLIENT', 'SETINFO', 'LIB-NAME', 'a b'])).toBe(
      '-ERR LIB-NAME cannot contain spaces, newlines or special characters.\r\n',
    );
  });

  test('INFO and LIST describe connections', async () => {
    const fixture = await respServer({ handlers: [clientCommand] });
    const a = openClient(fixture);
    const b = openClient(fixture);
    await b.send(['CLIENT', 'SETNAME', 'b']);
    expect(await a.send(['CLIENT', 'INFO'])).toMatch(
      /^\$\d+\r\nid=1 addr=127\.0\.0\.1:50000 .* cmd=client\n\r\n$/,
    );
    const all = await a.send(['CLIENT', 'LIST']);
    expect(all.match(/^id=/gm)).toHaveLength(2);
    expect(all).toContain('name=b');
    const one = await a.send(['CLIENT', 'LIST', 'ID', String(b.client.id)]);
    expect(one.match(/^id=/gm)).toHaveLength(1);
    expect(await a.send(['CLIENT', 'LIST', 'TYPE', 'pubsub'])).toBe('$0\r\n\r\n');
    expect(await a.send(['CLIENT', 'LIST', 'TYPE', 'normal'])).toContain('name=b');
    expect(await a.send(['CLIENT', 'LIST', 'TYPE', 'nope'])).toBe(
      "-ERR Unknown client type 'nope'\r\n",
    );
    expect(await a.send(['CLIENT', 'LIST', 'ID', '0'])).toBe('-ERR Invalid client ID\r\n');
    expect(await a.send(['CLIENT', 'LIST', 'FOO'])).toBe('-ERR syntax error\r\n');
  });

  test('unknown subcommands and arity follow Valkey', async () => {
    const c = openClient(await respServer({ handlers: [clientCommand] }));
    expect(await c.send(['CLIENT', 'KILL', 'x'])).toBe(
      "-ERR unknown subcommand 'KILL'. Try CLIENT HELP.\r\n",
    );
    expect(await c.send(['CLIENT', 'ID', 'x'])).toBe(
      "-ERR wrong number of arguments for 'client|id' command\r\n",
    );
    expect(await c.send(['CLIENT'])).toBe(
      "-ERR wrong number of arguments for 'client' command\r\n",
    );
  });
});
