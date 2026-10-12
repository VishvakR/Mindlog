import { describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import type { Plain } from '../support/kv-node.js';
import { kvNode } from '../support/kv-node.js';

async function scanAll(node: Awaited<ReturnType<typeof kvNode>>, ...options: string[]) {
  const seen: string[] = [];
  let cursor = '0';
  let calls = 0;
  do {
    const [next, keys] = (await node.run('SCAN', cursor, ...options)) as [string, string[]];
    seen.push(...keys);
    cursor = next;
    calls++;
  } while (cursor !== '0' && calls < 1000);
  return { seen: seen.sort(), calls };
}

describe('SCAN (Valkey scan.tcl)', () => {
  test('SCAN basic: every key exactly once', async () => {
    const node = await kvNode(createKvRegistry());
    const pairs = Array.from({ length: 50 }, (_, i) => [`key:${i}`, 'v']).flat();
    await node.run('MSET', ...pairs);
    const { seen, calls } = await scanAll(node, 'COUNT', '7');
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => `key:${i}`).sort());
    expect(calls).toBeGreaterThan(5);
  });

  test('SCAN MATCH and TYPE filter results', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('MSET', 'user:1', 'a', 'user:2', 'b', 'order:1', 'c');
    expect((await scanAll(node, 'MATCH', 'user:*')).seen).toEqual(['user:1', 'user:2']);
    expect((await scanAll(node, 'TYPE', 'string')).seen).toHaveLength(3);
    expect((await scanAll(node, 'TYPE', 'hash')).seen).toEqual([]);
  });

  test('SCAN skips deleted and expired keys', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('MSET', 'a', '1', 'b', '2', 'c', '3');
    await node.run('DEL', 'b');
    await node.run('PEXPIRE', 'c', '1');
    node.clock.advance(2n);
    expect((await scanAll(node)).seen).toEqual(['a']);
  });

  test('SCAN argument errors', async () => {
    const node = await kvNode(createKvRegistry());
    expect(await node.run('SCAN', 'x')).toEqual({ error: 'INVALID_ARGUMENT invalid cursor' });
    expect(await node.run('SCAN', '0', 'COUNT', '0')).toEqual({
      error: 'INVALID_ARGUMENT syntax error',
    });
    expect(await node.run('SCAN', '0', 'MATCH')).toEqual({
      error: 'INVALID_ARGUMENT syntax error',
    });
  });

  test('KEYS returns matching keys', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('MSET', 'foo_a', '1', 'foo_b', '2', 'bar', '3');
    const keys = (await node.run('KEYS', 'foo*')) as Plain[];
    expect([...(keys as string[])].sort()).toEqual(['foo_a', 'foo_b']);
    expect(await node.run('KEYS', '*')).toHaveLength(3);
  });
});
