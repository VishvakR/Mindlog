import { describe, expect, test } from 'vitest';
import type { KvCommand } from '@mindlog/kv';
import { Keyspace, KvCommandRegistry, createKvRegistry, isWrite, replies } from '@mindlog/kv';
import { MemoryStore, MvccReader } from '@mindlog/storage';

const bytes = (...args: string[]) => args.map((a) => new TextEncoder().encode(a));
const echo: KvCommand = {
  name: 'ECHO',
  arity: 2,
  flags: ['readonly', 'fast'],
  execute: (_ks, [message]) => Promise.resolve(replies.bulk(message ?? new Uint8Array())),
};
const touch: KvCommand = {
  name: 'TOUCH',
  arity: -2,
  flags: ['readonly'],
  keys: { first: 1, last: -1, step: 1 },
  execute: (_ks, keys) => Promise.resolve(replies.integer(keys.length)),
};
const keyspace = new Keyspace({
  tenant: 't',
  nowMs: 0n,
  view: new MvccReader(new MemoryStore()),
  version: 0n,
});

describe('KvCommandRegistry', () => {
  const registry = new KvCommandRegistry().register(echo, touch);

  test('keysOf reads key arguments from the key positions', () => {
    const real = createKvRegistry();
    const keys = (...argv: string[]) =>
      real.keysOf(bytes(...argv)).map((k) => new TextDecoder().decode(k));
    expect(keys('GET', 'a')).toEqual(['a']);
    expect(keys('MSET', 'a', '1', 'b', '2')).toEqual(['a', 'b']);
    expect(keys('DEL', 'a', 'b', 'c')).toEqual(['a', 'b', 'c']);
    expect(keys('RENAME', 'a', 'b')).toEqual(['a', 'b']);
    expect(keys('PING')).toEqual([]);
    expect(keys('NOPE', 'a')).toEqual([]);
  });

  test('dispatches case-insensitively', async () => {
    expect(await registry.dispatch(keyspace, bytes('echo', 'hi'))).toEqual(
      replies.bulk(bytes('hi')[0] as Uint8Array),
    );
    expect(await registry.dispatch(keyspace, bytes('Touch', 'a', 'b', 'c'))).toEqual(
      replies.integer(3),
    );
  });

  test('enforces exact and minimum arity with the Valkey message', async () => {
    expect(await registry.dispatch(keyspace, bytes('ECHO'))).toEqual(
      replies.error('INVALID_ARGUMENT', "wrong number of arguments for 'echo' command"),
    );
    expect(await registry.dispatch(keyspace, bytes('ECHO', 'a', 'b'))).toEqual(
      replies.errors.arity('echo'),
    );
    expect(await registry.dispatch(keyspace, bytes('TOUCH'))).toEqual(
      replies.errors.arity('touch'),
    );
  });

  test('reports unknown commands like Valkey', async () => {
    expect(await registry.dispatch(keyspace, bytes('FOO', 'a', 'b'))).toEqual(
      replies.error(
        'INVALID_ARGUMENT',
        "unknown command 'FOO', with args beginning with: 'a' 'b' ",
      ),
    );
  });

  test('refuses duplicate names and reports flags', () => {
    expect(() => new KvCommandRegistry().register(echo, { ...echo, name: 'echo' })).toThrow(
      /already/,
    );
    expect(isWrite(echo)).toBe(false);
    expect(registry.list().map((c) => c.name)).toEqual(['ECHO', 'TOUCH']);
  });
});
