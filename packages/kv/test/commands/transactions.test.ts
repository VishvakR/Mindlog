import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry, watchVersion } from '@mindlog/kv';
import { MvccReader } from '@mindlog/storage';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});
const version = (key: string) =>
  watchVersion(new MvccReader(node.store), 't', new TextEncoder().encode(key));

describe('MULTI/EXEC batches (Valkey multi.tcl)', () => {
  test('MULTI / EXEC basics: every command runs in order, reads included', async () => {
    expect(
      await node.batch([
        ['SET', 'x', '1'],
        ['INCR', 'x'],
        ['GET', 'x'],
        ['RPUSH', 'l', 'a', 'b'],
        ['LRANGE', 'l', '0', '-1'],
      ]),
    ).toEqual(['OK', 2, '2', 2, ['a', 'b']]);
  });

  test('a runtime error in one command does not stop the others', async () => {
    await node.run('SET', 's', 'string');
    expect(
      await node.batch([
        ['INCR', 'x'],
        ['LPUSH', 's', 'a'],
        ['INCR', 'x'],
      ]),
    ).toEqual([
      1,
      { error: 'WRONG_TYPE Operation against a key holding the wrong kind of value' },
      2,
    ]);
  });

  test('EXEC succeeds when watched keys are unchanged', async () => {
    await node.run('SET', 'x', '1');
    const v = await version('x');
    expect(await node.batch([['SET', 'x', '2']], [['x', v]])).toEqual(['OK']);
  });

  test('EXEC fails if a watched key was modified, created or deleted', async () => {
    await node.run('SET', 'x', '1');
    const v = await version('x');
    await node.run('SET', 'x', '1');
    expect(await node.batch([['SET', 'x', '2']], [['x', v]])).toBeNull();
    expect(await node.run('GET', 'x')).toBe('1');

    const absent = await version('y');
    await node.run('SET', 'y', 'v');
    await node.run('DEL', 'y');
    expect(await node.batch([['SET', 'z', '1']], [['y', absent]])).toBeNull();
    expect(await node.run('EXISTS', 'z')).toBe(0);
  });

  test('a modified collection invalidates WATCH too', async () => {
    await node.run('HSET', 'h', 'f', '1');
    const v = await version('h');
    await node.run('HSET', 'h', 'f', '1');
    expect(await node.batch([['HSET', 'h', 'f', '2']], [['h', v]])).toBeNull();
  });
});
