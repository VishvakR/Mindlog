import { describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

describe('PING / ECHO / TIME', () => {
  test('PING and ECHO', async () => {
    const node = await kvNode(createKvRegistry());
    expect(await node.run('PING')).toBe('PONG');
    expect(await node.run('PING', 'hello')).toBe('hello');
    expect(await node.run('PING', 'a', 'b')).toEqual({
      error: "INVALID_ARGUMENT wrong number of arguments for 'ping' command",
    });
    expect(await node.run('ECHO', 'x')).toBe('x');
  });

  test('TIME reports seconds and microseconds of the current time', async () => {
    const node = await kvNode(createKvRegistry(), 1_760_000_000_123n);
    expect(await node.run('TIME')).toEqual(['1760000000', '123000']);
  });

  test('PING and TIME can run inside a MULTI batch', async () => {
    const node = await kvNode(createKvRegistry(), 1_760_000_000_500n);
    expect(await node.batch([['PING'], ['TIME']])).toEqual(['PONG', ['1760000000', '500000']]);
  });
});
