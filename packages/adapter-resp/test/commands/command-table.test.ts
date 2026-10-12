import { describe, expect, test } from 'vitest';
import type { KvReply } from '@mindlog/proto';
import { CommandTable, RespWriter, loadCommandSpecs } from '@mindlog/adapter-resp';

const specs = loadCommandSpecs();
const table = new CommandTable(specs);
const argv = (...args: string[]) => args.map((a) => Buffer.from(a));
const resp2 = (reply: KvReply) => {
  const writer = new RespWriter();
  writer.write(reply, 2);
  return writer.take().toString('latin1');
};

/** Converts a reply to plain JS for assertions. */
function plain(reply: KvReply | undefined): unknown {
  const kind = reply?.kind;
  switch (kind?.case) {
    case 'bulk':
      return Buffer.from(kind.value).toString();
    case 'simple':
      return kind.value;
    case 'integer':
      return Number(kind.value);
    case 'array':
    case 'set':
      return kind.value.items.map(plain);
    case 'map':
      return Object.fromEntries(kind.value.entries.map((e) => [plain(e.key), plain(e.value)]));
    case 'error':
      return { error: kind.value.message };
    default:
      return null;
  }
}

describe('COMMAND', () => {
  test('COUNT and LIST', () => {
    expect(plain(table.execute(argv('COMMAND', 'COUNT')))).toBe(specs.size);
    expect(plain(table.execute(argv('command', 'list')))).toContain('json.set');
  });

  test('INFO has Valkey reply shape', () => {
    const [get, missing] = plain(
      table.execute(argv('COMMAND', 'INFO', 'get', 'nope')),
    ) as unknown[][];
    expect(get?.slice(0, 7)).toEqual([
      'get',
      2,
      ['readonly', 'fast'],
      1,
      1,
      1,
      ['@read', '@fast', '@string'],
    ]);
    expect(missing).toBeNull();
    const [mset] = plain(table.execute(argv('COMMAND', 'INFO', 'mset'))) as unknown[][];
    expect(mset?.[8]).toEqual([
      {
        flags: ['RW'],
        begin_search: { type: 'index', spec: { index: 1 } },
        find_keys: { type: 'range', spec: { lastkey: -1, keystep: 2, limit: 0 } },
      },
    ]);
  });

  test('container commands list their subcommands', () => {
    const [client] = plain(table.execute(argv('COMMAND', 'INFO', 'client'))) as unknown[][];
    const subs = (client?.[9] as unknown[][]).map((s) => s[0]);
    expect(subs).toContain('client|setname');
    const [setname] = plain(
      table.execute(argv('COMMAND', 'INFO', 'client|setname')),
    ) as unknown[][];
    expect(setname?.[1]).toBe(3);
  });

  test('DOCS returns summaries and argument trees', () => {
    const docs = plain(table.execute(argv('COMMAND', 'DOCS', 'set', 'unknown'))) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(docs)).toEqual(['set']);
    expect(docs.set?.group).toBe('string');
    const args = docs.set?.arguments as Record<string, unknown>[];
    expect(args[0]).toEqual({ name: 'key', type: 'key', display_text: 'key', key_spec_index: 0 });
    expect(args[2]).toMatchObject({ name: 'condition', type: 'oneof', flags: ['optional'] });
    expect(resp2(table.execute(argv('COMMAND', 'DOCS', 'get')))).toMatch(
      /^\*2\r\n\$3\r\nget\r\n\*\d+\r\n/,
    );
  });

  test('no subcommand lists every command; errors follow Valkey', () => {
    expect((plain(table.execute(argv('COMMAND'))) as unknown[]).length).toBe(specs.size);
    expect(plain(table.execute(argv('COMMAND', 'FOO')))).toEqual({
      error: "unknown subcommand 'FOO'. Try COMMAND HELP.",
    });
    expect(plain(table.execute(argv('COMMAND', 'COUNT', 'x')))).toEqual({
      error: "wrong number of arguments for 'command|count' command",
    });
  });
});
