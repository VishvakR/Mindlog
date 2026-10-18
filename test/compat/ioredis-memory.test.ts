import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

/**
 * MEM.* over RESP with ioredis (PLAN 15.1). No model service is configured, so
 * memory runs in degraded mode: raw episodic memories, keyword recall.
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

type Flat = Array<string | number | null | Flat>;
/** A RESP2 map reply (flat key/value array) as an object. */
function asMap(reply: unknown): Record<string, unknown> {
  const flat = reply as Flat;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < flat.length; i += 2) out[String(flat[i])] = flat[i + 1];
  return out;
}

describe('ioredis: MEM.*', () => {
  test('MEM.ADD stores, MEM.SEARCH finds, MEM.GET and MEM.HISTORY show, MEM.FORGET hides', async () => {
    const added = asMap(await redis.call('MEM.ADD', 'alice', 'I prefer dark roast coffee.'));
    expect(added.degraded).toBe(1);
    const ids = added.ids as string[];
    expect(ids).toHaveLength(1);
    expect(typeof added.job).toBe('string');

    await redis.call('MEM.ADD', 'alice', 'The train to Lisbon was late.', 'KIND', 'episodic');
    const found = (await redis.call('MEM.SEARCH', 'alice', 'dark roast', 'K', '5')) as Flat[];
    expect(found.map((item) => asMap(item).text)).toEqual(['I prefer dark roast coffee.']);
    expect(Number(asMap(found[0]).score)).toBeGreaterThan(0);

    const got = asMap(await redis.call('MEM.GET', 'alice', ids[0] ?? ''));
    expect(got).toMatchObject({
      id: ids[0],
      kind: 'episodic',
      text: 'I prefer dark roast coffee.',
    });

    expect(await redis.call('MEM.FORGET', 'alice', ids[0] ?? '')).toBe(1);
    expect(await redis.call('MEM.SEARCH', 'alice', 'dark roast')).toEqual([]);
    const history = (await redis.call('MEM.HISTORY', 'alice', ids[0] ?? '')) as Flat[];
    expect(history.map((h) => asMap(h).expired)).toEqual([1, 0]);
    expect(await redis.call('MEM.GET', 'alice', 'no-such-id')).toBeNull();
  });

  test('scopes are separate, and agent scopes inherit with INHERIT', async () => {
    await redis.call('MEM.ADD', 'bob', 'Bob likes green tea', 'KIND', 'semantic');
    await redis.call('MEM.ADD', 'bob/helper', 'Helper notes about green tea', 'KIND', 'semantic');
    expect(await redis.call('MEM.SEARCH', 'carol', 'green tea')).toEqual([]);
    const own = (await redis.call('MEM.SEARCH', 'bob/helper', 'green tea')) as Flat[];
    expect(own.map((i) => asMap(i).text)).toEqual(['Helper notes about green tea']);
    const inherited = (await redis.call(
      'MEM.SEARCH',
      'bob/helper',
      'green tea',
      'INHERIT',
    )) as Flat[];
    expect(inherited).toHaveLength(2);
  });

  test('bad arguments are errors', async () => {
    await expect(redis.call('MEM.ADD', 'alice', 'x', 'KIND', 'gossip')).rejects.toThrow(/kind/i);
    await expect(redis.call('MEM.SEARCH', 'alice', 'x', 'K', 'many')).rejects.toThrow(/integer/);
    await expect(redis.call('MEM.ADD', 'alice')).rejects.toThrow(/wrong number of arguments/);
  });
});
