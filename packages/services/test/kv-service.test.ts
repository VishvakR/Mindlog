import { describe, expect, test } from 'vitest';
import { serviceNode } from './support/service-node.js';

describe('KvService', () => {
  test('reads and writes go through the right paths', async () => {
    const node = await serviceNode();
    const s = node.open();
    expect(await node.run(s, 'GET', 'k')).toBeNull();
    expect(await node.run(s, 'SET', 'k', 'v')).toBe('OK');
    expect(await node.run(s, 'GET', 'k')).toBe('v');
    expect(await node.run(s, 'INCR', 'n')).toBe(1);
  });

  test('arity and unknown commands are answered without proposing', async () => {
    const node = await serviceNode();
    const s = node.open();
    expect(await node.run(s, 'SET', 'k')).toEqual({
      error: "INVALID_ARGUMENT wrong number of arguments for 'set' command",
    });
    expect(await node.run(s, 'BOGUS', 'x')).toEqual({
      error: "INVALID_ARGUMENT unknown command 'BOGUS', with args beginning with: 'x' ",
    });
  });

  test('a password makes sessions authenticate first', async () => {
    const node = await serviceNode({ password: 'pw' });
    const s = node.open();
    expect(await node.run(s, 'GET', 'k')).toEqual({
      error: 'UNAUTHENTICATED Authentication required.',
    });
    expect(await node.run(s, 'AUTH', 'nope')).toEqual({
      error: 'INVALID_CREDENTIALS invalid username-password pair or user is disabled.',
    });
    expect(await node.run(s, 'AUTH', 'default', 'pw')).toBe('OK');
    expect(await node.run(s, 'SET', 'k', 'v')).toBe('OK');
    expect(await node.run(node.open(), 'AUTH', 'pw')).toBe('OK');
  });

  test('AUTH without a configured password is an error', async () => {
    const node = await serviceNode();
    const result = await node.run(node.open(), 'AUTH', 'x');
    expect(result).toMatchObject({
      error: expect.stringContaining('without any password configured') as string,
    });
  });

  test('without a password the default user is nopass, as in Valkey', async () => {
    const node = await serviceNode();
    expect(node.service.authenticationRequired).toBe(false);
    expect(await node.run(node.open(), 'AUTH', 'default', 'anything')).toBe('OK');
    expect(await node.run(node.open(), 'AUTH', 'alice', 'x')).toEqual({
      error: 'INVALID_CREDENTIALS invalid username-password pair or user is disabled.',
    });
  });

  test('records latency and errors per command with bounded labels', async () => {
    const node = await serviceNode();
    const s = node.open();
    await node.run(s, 'SET', 'k', 'v');
    await node.run(s, 'SET', 'k');
    await node.run(s, 'WHATEVER-RANDOM-NAME');
    expect(
      node.metrics.observations('mindlog_kv_command_latency_seconds', { command: 'set' }),
    ).toHaveLength(2);
    expect(
      node.metrics.value('mindlog_kv_command_errors_total', {
        command: 'set',
        code: 'INVALID_ARGUMENT',
      }),
    ).toBe(1);
    expect(
      node.metrics.value('mindlog_kv_command_errors_total', {
        command: 'unknown',
        code: 'INVALID_ARGUMENT',
      }),
    ).toBe(1);
  });

  test('a full proposal queue surfaces as BUSY', async () => {
    const node = await serviceNode({ maxQueue: 1 });
    const s = node.open();
    const results = await Promise.all([1, 2, 3].map((i) => node.run(s, 'SET', `k${i}`, 'v')));
    expect(results).toContainEqual({ error: 'BUSY too many pending writes' });
  });
});
