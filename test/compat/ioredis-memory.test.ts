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

  test('MEM.PACK packs within the budget and MEM.SEARCH takes a recipe', async () => {
    await redis.call('MEM.ADD', 'dave', 'Dave plays the cello on Sundays', 'KIND', 'semantic');
    await redis.call('MEM.ADD', 'dave', 'Dave walked to the cello lesson', 'KIND', 'episodic');
    const packed = asMap(await redis.call('MEM.PACK', 'dave', 'cello', 'BUDGET', '200'));
    expect(packed.context).toBe(
      '## Facts\n- Dave plays the cello on Sundays\n\n## Recent episodes\n- Dave walked to the cello lesson',
    );
    expect(packed.budget).toBe(200);
    expect(Number(packed.tokens)).toBeLessThanOrEqual(200);
    expect(packed.dropped).toEqual([]);
    const tight = asMap(await redis.call('MEM.PACK', 'dave', 'cello', 'BUDGET', '12'));
    expect(tight.ids as string[]).toHaveLength(1);
    expect(tight.dropped as string[]).toHaveLength(1);
    const rag = (await redis.call('MEM.SEARCH', 'dave', 'cello', 'RECIPE', 'rag')) as Flat[];
    expect(rag).toEqual([]); // degraded: rag has only the vector retriever
    await expect(redis.call('MEM.SEARCH', 'dave', 'x', 'RECIPE', 'magic')).rejects.toThrow(
      /recipe/,
    );
  });

  test('CACHE.SET, CACHE.GET and CACHE.DEL; forgetting a memory drops the entries using it', async () => {
    const added = asMap(
      await redis.call('MEM.ADD', 'erin', 'Erin drinks oolong', 'KIND', 'semantic'),
    );
    const memory = (added.ids as string[])[0] ?? '';
    const id = (await redis.call(
      'CACHE.SET',
      'erin',
      'What does Erin drink?',
      'Oolong.',
      'USING',
      memory,
      'TTL',
      '3600',
    )) as string;
    const kept = (await redis.call('CACHE.SET', 'erin', 'Hello?', 'Hi.')) as string;
    // No model service here: only the exact normalised prompt matches.
    const hit = asMap(await redis.call('CACHE.GET', 'erin', '  what does ERIN drink? '));
    expect(hit).toMatchObject({ id, answer: 'Oolong.', using: [memory] });
    expect(Number(hit.similarity)).toBe(1);
    expect(await redis.call('CACHE.GET', 'erin', 'what does erin eat?')).toBeNull();
    expect(await redis.call('CACHE.GET', 'frank', 'what does erin drink?')).toBeNull();
    expect(await redis.call('MEM.FORGET', 'erin', memory)).toBe(1);
    expect(await redis.call('CACHE.GET', 'erin', 'what does erin drink?')).toBeNull();
    expect(await redis.call('CACHE.DEL', 'erin', kept, id)).toBe(1);
    expect(await redis.call('CACHE.GET', 'erin', 'hello?')).toBeNull();
    await expect(redis.call('CACHE.SET', 'erin', 'p', 'a', 'BOGUS')).rejects.toThrow(/syntax/i);
  });

  test('MEM.TRUST releases web content, MEM.CONFLICTS lists, MEM.RESOLVE checks, ASOF reads the past', async () => {
    const added = asMap(
      await redis.call('MEM.ADD', 'dora', 'Espresso beans cost more now.', 'SOURCE', 'web'),
    );
    const id = (added.ids as string[])[0] ?? '';
    const before = asMap(await redis.call('MEM.GET', 'dora', id));
    expect(before.trust).toBe('quarantined');
    expect(await redis.call('MEM.SEARCH', 'dora', 'espresso beans')).toEqual([]);
    expect(await redis.call('MEM.TRUST', 'dora', 'normal', id)).toBe(1);
    const found = (await redis.call('MEM.SEARCH', 'dora', 'espresso beans')) as Flat[];
    expect(found.map((item) => asMap(item).id)).toEqual([id]);

    expect(await redis.call('MEM.CONFLICTS', 'dora', 'ALL')).toEqual([]);
    await expect(redis.call('MEM.RESOLVE', 'dora', 'nope', 'KEEP', 'a')).rejects.toThrow(
      /NOT_FOUND|no conflict/,
    );
    await expect(redis.call('MEM.RESOLVE', 'dora', 'nope', 'KEEP', 'neither')).rejects.toThrow(
      /keep/,
    );

    // As of 2020 nothing was stored; ASOF with an ISO time reads that state.
    expect(await redis.call('MEM.GET', 'dora', id, 'ASOF', '2020-01-01')).toBeNull();
    // Log index 1 is before this scope's first command.
    expect(await redis.call('MEM.GET', 'dora', id, 'ASOF', '1')).toBeNull();
  });

  test('bad arguments are errors', async () => {
    await expect(redis.call('MEM.ADD', 'alice', 'x', 'KIND', 'gossip')).rejects.toThrow(/kind/i);
    await expect(redis.call('MEM.SEARCH', 'alice', 'x', 'K', 'many')).rejects.toThrow(/integer/);
    await expect(redis.call('MEM.ADD', 'alice')).rejects.toThrow(/wrong number of arguments/);
  });
});
