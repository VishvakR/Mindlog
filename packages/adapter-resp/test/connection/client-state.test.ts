import { describe, expect, test } from 'vitest';
import { ClientRegistry } from '@mindlog/adapter-resp';

describe('ClientRegistry', () => {
  test('assigns increasing ids that are never reused', () => {
    const clients = new ClientRegistry();
    const a = clients.register('127.0.0.1:1', '127.0.0.1:6379', 0n);
    const b = clients.register('127.0.0.1:2', '127.0.0.1:6379', 0n);
    clients.remove(a.id);
    const c = clients.register('127.0.0.1:3', '127.0.0.1:6379', 0n);
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(clients.size).toBe(2);
    expect(clients.list().map((x) => x.id)).toEqual([2, 3]);
  });
});

describe('ClientState', () => {
  test('describes itself as a CLIENT LIST line', () => {
    const client = new ClientRegistry().register('10.0.0.1:5000', '10.0.0.2:6379', 1_000n);
    client.name = 'worker';
    client.protocol = 3;
    client.lastCommand = 'client|info';
    client.lastActiveMs = 4_500n;
    expect(client.describe(11_000n)).toBe(
      'id=1 addr=10.0.0.1:5000 laddr=10.0.0.2:6379 name=worker age=10 idle=6 flags=N db=0 multi=-1 resp=3 lib-name= lib-ver= cmd=client|info',
    );
  });

  test('a clock that moved backwards reports zero', () => {
    const client = new ClientRegistry().register('a', 'b', 5_000n);
    expect(client.describe(1_000n)).toContain('age=0 idle=0');
  });
});
