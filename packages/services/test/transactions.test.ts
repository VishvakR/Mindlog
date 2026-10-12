import { describe, expect, test } from 'vitest';
import { serviceNode } from './support/service-node.js';

describe('MULTI / EXEC / DISCARD / WATCH (Valkey multi.tcl)', () => {
  test('MULTI / EXEC basics', async () => {
    const node = await serviceNode();
    const s = node.open();
    expect(await node.run(s, 'MULTI')).toBe('OK');
    expect(await node.run(s, 'RPUSH', 'l', 'a')).toBe('QUEUED');
    expect(await node.run(s, 'LRANGE', 'l', '0', '-1')).toBe('QUEUED');
    expect(await node.run(s, 'EXEC')).toEqual([1, ['a']]);
  });

  test('DISCARD drops queued commands', async () => {
    const node = await serviceNode();
    const s = node.open();
    await node.run(s, 'MULTI');
    await node.run(s, 'SET', 'k', 'v');
    expect(await node.run(s, 'DISCARD')).toBe('OK');
    expect(await node.run(s, 'GET', 'k')).toBeNull();
  });

  test('Nested MULTI are not allowed; EXEC and DISCARD need MULTI', async () => {
    const node = await serviceNode();
    const s = node.open();
    expect(await node.run(s, 'EXEC')).toEqual({ error: 'INVALID_ARGUMENT EXEC without MULTI' });
    expect(await node.run(s, 'DISCARD')).toEqual({
      error: 'INVALID_ARGUMENT DISCARD without MULTI',
    });
    await node.run(s, 'MULTI');
    expect(await node.run(s, 'MULTI')).toEqual({
      error: 'INVALID_ARGUMENT MULTI calls can not be nested',
    });
  });

  test('EXEC fails if there are errors while queueing commands', async () => {
    const node = await serviceNode();
    const s = node.open();
    await node.run(s, 'MULTI');
    await node.run(s, 'SET', 'k', 'v');
    expect(await node.run(s, 'NOTACOMMAND')).toMatchObject({
      error: expect.stringContaining('unknown command') as string,
    });
    expect(await node.run(s, 'SET', 'k')).toMatchObject({
      error: expect.stringContaining('wrong number') as string,
    });
    expect(await node.run(s, 'EXEC')).toEqual({
      error: 'EXEC_ABORTED Transaction discarded because of previous errors.',
    });
    expect(await node.run(s, 'GET', 'k')).toBeNull();
  });

  test('EXEC fails if a watched key changed; succeeds otherwise', async () => {
    const node = await serviceNode();
    const a = node.open();
    const b = node.open();
    await node.run(a, 'SET', 'x', '1');
    expect(await node.run(a, 'WATCH', 'x')).toBe('OK');
    await node.run(b, 'SET', 'x', '2');
    await node.run(a, 'MULTI');
    await node.run(a, 'SET', 'x', '3');
    expect(await node.run(a, 'EXEC')).toBeNull();
    expect(await node.run(a, 'GET', 'x')).toBe('2');

    await node.run(a, 'WATCH', 'x');
    await node.run(a, 'MULTI');
    await node.run(a, 'SET', 'x', '4');
    expect(await node.run(a, 'EXEC')).toEqual(['OK']);
  });

  test('UNWATCH and EXEC clear the watch list; WATCH inside MULTI is not allowed', async () => {
    const node = await serviceNode();
    const s = node.open();
    await node.run(s, 'WATCH', 'x');
    expect(await node.run(s, 'UNWATCH')).toBe('OK');
    await node.run(node.open(), 'SET', 'x', 'changed');
    await node.run(s, 'MULTI');
    expect(await node.run(s, 'WATCH', 'y')).toEqual({
      error: 'INVALID_ARGUMENT WATCH inside MULTI is not allowed',
    });
    await node.run(s, 'GET', 'x');
    expect(await node.run(s, 'EXEC')).toEqual(['changed']);
  });
});
