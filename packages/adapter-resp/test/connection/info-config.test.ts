import { describe, expect, test } from 'vitest';
import { clientCommand, configCommand, helloCommand, infoCommand } from '@mindlog/adapter-resp';
import { openClient, respServer } from '../support/resp-node.js';

const server = () =>
  respServer({ handlers: [infoCommand, configCommand, helloCommand, clientCommand] });

const body = (reply: string) => reply.replace(/^\$\d+\r\n/, '').replace(/\r\n$/, '');

describe('INFO', () => {
  test('default sections carry the fields clients probe', async () => {
    const fixture = await server();
    const c = openClient(fixture);
    fixture.clock.advance(90_000n);
    const info = body(await c.send(['INFO']));
    expect(info).toMatch(/^# Server\r\nredis_version:7\.2\.0\r\nmindlog_version:0\.0\.0\r\n/);
    expect(info).toContain('\r\nuptime_in_seconds:90\r\n');
    expect(info).toContain('\r\n\r\n# Clients\r\nconnected_clients:1\r\nmaxclients:10000');
    expect(info).toContain('# Persistence\r\nloading:0\r\n');
    expect(info).toContain('# Replication\r\nrole:master\r\n');
  });

  test('sections can be selected; unknown ones are empty', async () => {
    const c = openClient(await server());
    const replication = body(await c.send(['INFO', 'Replication']));
    expect(replication).toBe('# Replication\r\nrole:master\r\nconnected_slaves:0\r\n');
    expect(await c.send(['INFO', 'nosuch'])).toBe('$0\r\n\r\n');
    expect(body(await c.send(['INFO', 'all']))).toContain('# Server');
  });

  test('the bulk length matches the body', async () => {
    const c = openClient(await server());
    const reply = await c.send(['INFO']);
    const [, length] = /^\$(\d+)\r\n/.exec(reply) ?? [];
    expect(Buffer.byteLength(body(reply))).toBe(Number(length));
  });
});

describe('CONFIG GET', () => {
  test('matches settings by glob, map in RESP3 and flat array in RESP2', async () => {
    const c = openClient(await server());
    expect(await c.send(['CONFIG', 'GET', 'databases'])).toBe(
      '*2\r\n$9\r\ndatabases\r\n$1\r\n1\r\n',
    );
    expect(await c.send(['CONFIG', 'GET', 'MAX*'])).toBe(
      '*2\r\n$10\r\nmaxclients\r\n$5\r\n10000\r\n',
    );
    await c.send(['HELLO', '3']);
    expect(await c.send(['CONFIG', 'GET', 'nothing'])).toBe('%0\r\n');
    expect(await c.send(['CONFIG', 'GET', 'databases', 'maxclients'])).toMatch(/^%2\r\n/);
  });

  test('other subcommands are unknown', async () => {
    const c = openClient(await server());
    expect(await c.send(['CONFIG', 'SET', 'x', 'y'])).toBe(
      "-ERR unknown subcommand 'SET'. Try CONFIG HELP.\r\n",
    );
    expect(await c.send(['CONFIG', 'GET'])).toBe(
      "-ERR wrong number of arguments for 'config|get' command\r\n",
    );
  });
});
