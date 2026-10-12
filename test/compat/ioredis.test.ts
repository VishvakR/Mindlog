import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/**
 * Compatibility subset (PLAN 24, phase 1 gate): a real ioredis client against
 * a real node over TCP. ioredis also runs its INFO-based ready check.
 */
let server: Awaited<ReturnType<typeof startTestNode>>;
let redis: Redis;

beforeAll(async () => {
  server = await startTestNode();
  redis = new Redis({
    port: server.port,
    host: '127.0.0.1',
    lazyConnect: true,
    maxRetriesPerRequest: 0,
  });
  await redis.connect();
});

afterAll(async () => {
  redis.disconnect();
  await server.stop();
});

describe('ioredis: strings and keys', () => {
  test('GET / SET with options, counters, ranges', async () => {
    expect(await redis.set('s', 'hello')).toBe('OK');
    expect(await redis.get('s')).toBe('hello');
    expect(await redis.set('s', 'x', 'NX')).toBeNull();
    expect(await redis.set('s', 'world', 'XX', 'GET')).toBe('hello');
    expect(await redis.append('s', '!')).toBe(6);
    expect(await redis.getrange('s', 0, 2)).toBe('wor');
    expect(await redis.incr('n')).toBe(1);
    expect(await redis.incrby('n', 41)).toBe(42);
    expect(await redis.incrbyfloat('f', '1.5')).toBe('1.5');
    expect(await redis.mset({ a: '1', b: '2' })).toBe('OK');
    expect(await redis.mget('a', 'b', 'missing')).toEqual(['1', '2', null]);
    expect(await redis.exists('a', 'b', 'missing')).toBe(2);
    expect(await redis.type('a')).toBe('string');
    expect(await redis.del('a', 'b')).toBe(2);
  });

  test('binary-safe values round-trip as Buffers', async () => {
    const bytes = Buffer.from([0, 1, 13, 10, 255, 128]);
    await redis.set('bin', bytes);
    expect(await redis.getBuffer('bin')).toEqual(bytes);
  });

  test('expiry: EX, TTL, PERSIST, lazy expiry', async () => {
    await redis.set('e', 'v', 'EX', 100);
    const ttl = await redis.ttl('e');
    expect(ttl).toBeGreaterThan(98);
    expect(await redis.persist('e')).toBe(1);
    expect(await redis.ttl('e')).toBe(-1);
    await redis.set('short', 'v', 'PX', 30);
    await new Promise((r) => setTimeout(r, 60));
    expect(await redis.get('short')).toBeNull();
    expect(await redis.ttl('missing')).toBe(-2);
  });

  test('errors surface as ReplyError with Valkey messages', async () => {
    await redis.lpush('list', 'x');
    await expect(redis.get('list')).rejects.toThrow(
      /^WRONGTYPE Operation against a key holding the wrong kind of value/,
    );
    await redis.set('str', 'abc');
    await expect(redis.incr('str')).rejects.toThrow('ERR value is not an integer or out of range');
    await expect(redis.call('NOSUCHCOMMAND')).rejects.toThrow(
      /ERR unknown command 'NOSUCHCOMMAND'/,
    );
  });

  test('SCAN with MATCH iterates every key exactly once', async () => {
    const keys = Array.from({ length: 150 }, (_, i) => `scan:${String(i)}`);
    await redis.mset(Object.fromEntries(keys.map((k) => [k, '1'])));
    const seen: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'scan:*', 'COUNT', 20);
      seen.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.sort()).toEqual([...keys].sort());
  });
});

describe('ioredis: collections', () => {
  test('hashes', async () => {
    expect(await redis.hset('h', { f1: 'a', f2: 'b' })).toBe(2);
    expect(await redis.hgetall('h')).toEqual({ f1: 'a', f2: 'b' });
    expect(await redis.hincrby('h', 'c', 5)).toBe(5);
    expect(await redis.hdel('h', 'f1')).toBe(1);
    expect((await redis.hkeys('h')).sort()).toEqual(['c', 'f2']);
  });

  test('lists', async () => {
    expect(await redis.rpush('l', 'a', 'b', 'c')).toBe(3);
    expect(await redis.lpush('l', 'z')).toBe(4);
    expect(await redis.lrange('l', 0, -1)).toEqual(['z', 'a', 'b', 'c']);
    expect(await redis.lpop('l')).toBe('z');
    expect(await redis.rpop('l', 2)).toEqual(['c', 'b']);
    expect(await redis.llen('l')).toBe(1);
  });

  test('sets', async () => {
    expect(await redis.sadd('s1', 'a', 'b', 'c')).toBe(3);
    await redis.sadd('s2', 'b', 'c', 'd');
    expect((await redis.sinter('s1', 's2')).sort()).toEqual(['b', 'c']);
    expect(await redis.sismember('s1', 'a')).toBe(1);
    expect(await redis.scard('s1')).toBe(3);
  });

  test('sorted sets with scores', async () => {
    expect(await redis.zadd('z', 1, 'a', 2, 'b', 3, 'c')).toBe(3);
    expect(await redis.zrange('z', '0', '-1', 'WITHSCORES')).toEqual([
      'a',
      '1',
      'b',
      '2',
      'c',
      '3',
    ]);
    expect(await redis.zrangebyscore('z', '(1', '+inf')).toEqual(['b', 'c']);
    expect(await redis.zscore('z', 'b')).toBe('2');
    expect(await redis.zrank('z', 'c')).toBe(2);
    expect(await redis.zpopmin('z')).toEqual(['a', '1']);
  });

  test('JSON documents', async () => {
    expect(await redis.call('JSON.SET', 'doc', '$', '{"a":{"b":[1,2]}}')).toBe('OK');
    expect(await redis.call('JSON.GET', 'doc', '$.a.b')).toBe('[[1,2]]');
  });
});

describe('ioredis: pipelines and transactions', () => {
  test('pipelines keep order', async () => {
    const results = await redis.pipeline().set('p', '1').incr('p').get('p').exec();
    expect(results).toEqual([
      [null, 'OK'],
      [null, 2],
      [null, '2'],
    ]);
  });

  test('MULTI / EXEC is atomic', async () => {
    const results = await redis.multi().set('t', 'a').append('t', 'b').get('t').exec();
    expect(results).toEqual([
      [null, 'OK'],
      [null, 2],
      [null, 'ab'],
    ]);
  });

  test('WATCH aborts EXEC when a watched key changes', async () => {
    const other = redis.duplicate();
    await redis.set('w', '1');
    await redis.watch('w');
    await other.set('w', '2');
    expect(await redis.multi().set('w', '3').exec()).toBeNull();
    expect(await redis.get('w')).toBe('2');
    other.disconnect();
  });
});

describe('ioredis: connection', () => {
  test('client name, PING, ECHO, SELECT 0, DBSIZE', async () => {
    expect(await redis.client('SETNAME', 'compat')).toBe('OK');
    expect(await redis.client('GETNAME')).toBe('compat');
    expect(await redis.ping()).toBe('PONG');
    expect(await redis.echo('hi')).toBe('hi');
    expect(await redis.select(0)).toBe('OK');
    expect(await redis.dbsize()).toBeGreaterThan(0);
  });

  test('a password-protected node accepts AUTH from the client options', async () => {
    const secured = await startTestNode({ auth: { password: 'secret' } });
    const client = new Redis({
      port: secured.port,
      host: '127.0.0.1',
      password: 'secret',
      lazyConnect: true,
    });
    await client.connect();
    expect(await client.set('k', 'v')).toBe('OK');
    client.disconnect();
    // As with Redis 7: ioredis 6 opens with HELLO 3, which a protected server refuses.
    const anonymous = new Redis({
      port: secured.port,
      host: '127.0.0.1',
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    const errors: string[] = [];
    anonymous.on('error', (e: Error) => errors.push(e.message));
    await expect(anonymous.connect()).rejects.toThrow('Connection is closed');
    expect(errors[0]).toMatch(/^NOAUTH HELLO must be called with the client already authenticated/);
    await secured.stop();
  });
});
