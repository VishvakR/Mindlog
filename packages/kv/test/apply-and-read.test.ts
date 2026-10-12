import { describe, expect, test } from 'vitest';
import type { KvCommand } from '@mindlog/kv';
import { KvCommandRegistry, headerKey, replies } from '@mindlog/kv';
import { KvType } from '@mindlog/proto';
import { kvNode } from './support/kv-node.js';

const decoder = new TextDecoder();
const bump: KvCommand = {
  name: 'BUMP',
  arity: 2,
  flags: ['write'],
  async execute(ks, [name]) {
    if (!name) return replies.errors.syntax();
    const header = (await ks.header(name)) ?? ks.fresh(KvType.STRING);
    const next = Number(decoder.decode(header.value) || '0') + 1;
    header.value = new TextEncoder().encode(String(next));
    ks.write(name, header);
    return replies.integer(next);
  },
};
const peek: KvCommand = {
  name: 'PEEK',
  arity: 2,
  flags: ['readonly'],
  async execute(ks, [name]) {
    const header = name ? await ks.header(name) : undefined;
    return header ? replies.bulk(header.value) : replies.nil();
  },
};

describe('KV apply and read paths', () => {
  test('writes go through apply, reads see applied state', async () => {
    const node = await kvNode(new KvCommandRegistry().register(bump, peek));
    expect(await node.run('PEEK', 'n')).toBeNull();
    expect(await node.run('BUMP', 'n')).toBe(1);
    expect(await node.run('bump', 'n')).toBe(2);
    expect(await node.run('PEEK', 'n')).toBe('2');
  });

  test('unknown commands and arity errors are recorded results', async () => {
    const node = await kvNode(new KvCommandRegistry().register(bump, peek));
    expect(await node.run('NOPE', 'x')).toEqual({
      error: "INVALID_ARGUMENT unknown command 'NOPE', with args beginning with: 'x' ",
    });
    expect(await node.run('BUMP')).toEqual({
      error: "INVALID_ARGUMENT wrong number of arguments for 'bump' command",
    });
  });

  test('the header key is tenant-scoped', () => {
    expect(decoder.decode(headerKey('acme', new TextEncoder().encode('k')))).toContain('acme');
  });
});
