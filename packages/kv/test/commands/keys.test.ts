import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

describe('key commands (Valkey keyspace.tcl)', () => {
  test('DEL against a single item and multiple keys', async () => {
    await node.run('MSET', 'a', '1', 'b', '2', 'c', '3');
    expect(await node.run('DEL', 'a')).toBe(1);
    expect(await node.run('DEL', 'a', 'b', 'c', 'missing')).toBe(2);
    expect(await node.run('UNLINK', 'b')).toBe(0);
  });

  test('EXISTS counts every argument, duplicates included', async () => {
    await node.run('SET', 'a', '1');
    expect(await node.run('EXISTS', 'a', 'a', 'b')).toBe(2);
  });

  test('expired keys do not exist', async () => {
    await node.run('SET', 'a', '1', 'PX', '10');
    node.clock.advance(11n);
    expect(await node.run('EXISTS', 'a')).toBe(0);
    expect(await node.run('DEL', 'a')).toBe(0);
  });

  test('TYPE', async () => {
    await node.run('SET', 's', 'v');
    expect(await node.run('TYPE', 's')).toBe('string');
    expect(await node.run('TYPE', 'missing')).toBe('none');
  });

  test('RENAME basic usage, onto an existing key, and the TTL moves with it', async () => {
    await node.run('SET', 'a', 'hello', 'PX', '100');
    expect(await node.run('RENAME', 'a', 'b')).toBe('OK');
    expect(await node.run('GET', 'a')).toBeNull();
    expect(await node.run('GET', 'b')).toBe('hello');
    expect(await node.run('PTTL', 'b')).toBe(100);
    await node.run('SET', 'c', 'other');
    expect(await node.run('RENAME', 'b', 'c')).toBe('OK');
    expect(await node.run('GET', 'c')).toBe('hello');
    node.clock.advance(101n);
    expect(await node.run('GET', 'c')).toBeNull();
  });

  test('RENAME errors and same-key renames', async () => {
    expect(await node.run('RENAME', 'missing', 'x')).toEqual({
      error: 'INVALID_ARGUMENT no such key',
    });
    await node.run('SET', 'a', '1');
    expect(await node.run('RENAME', 'a', 'a')).toBe('OK');
    expect(await node.run('GET', 'a')).toBe('1');
    expect(await node.run('RENAMENX', 'a', 'a')).toBe(0);
  });

  test('RENAMENX does not overwrite', async () => {
    await node.run('MSET', 'a', '1', 'b', '2');
    expect(await node.run('RENAMENX', 'a', 'b')).toBe(0);
    expect(await node.run('RENAMENX', 'a', 'c')).toBe(1);
    expect(await node.run('MGET', 'a', 'b', 'c')).toEqual([null, '2', '1']);
  });

  test('DBSIZE counts live keys only', async () => {
    expect(await node.run('DBSIZE')).toBe(0);
    await node.run('MSET', 'a', '1', 'b', '2', 'c', '3');
    await node.run('SET', 'd', '4', 'PX', '5');
    await node.run('DEL', 'b');
    expect(await node.run('DBSIZE')).toBe(3);
    node.clock.advance(6n);
    expect(await node.run('DBSIZE')).toBe(2);
  });
});
