import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { KeyValue } from '@mindlog/services';
import { KvBrowser, keyQuerySchema, scanQuerySchema, writeKeyBodySchema } from '@mindlog/services';
import { serviceNode } from './support/service-node.js';

const key = (s: string) => new TextEncoder().encode(s);
const q = keyQuerySchema.parse({});

async function setup() {
  const node = await serviceNode();
  return { node, browser: new KvBrowser(node.service), s: node.open() };
}

const values: KeyValue[] = [
  { type: 'string', value: 'héllo' },
  {
    type: 'hash',
    value: [
      { field: 'a', value: '1' },
      { field: 'b', value: '2' },
    ],
  },
  { type: 'list', value: ['x', 'y', 'x'] },
  { type: 'set', value: ['m'] },
  {
    type: 'zset',
    value: [
      { member: 'lo', score: -1.5 },
      { member: 'hi', score: 3 },
    ],
  },
  { type: 'json', value: { a: [1, 'two', null], b: { c: true } } },
];

describe('KvBrowser', () => {
  test.each(values)('$type round-trips through write and read', async (value) => {
    const { browser, s } = await setup();
    expect((await browser.write(s, key('k'), value)).ok).toBe(true);
    const read = await browser.read(s, key('k'), q);
    expect(read).toMatchObject({
      ok: true,
      value: { ...value, key: 'k', ttlMs: null, truncated: false },
    });
  });

  test('write replaces the old value and type atomically, and sets the TTL', async () => {
    const { node, browser, s } = await setup();
    await node.run(s, 'RPUSH', 'k', 'old1', 'old2');
    expect(
      (
        await browser.write(s, key('k'), {
          type: 'hash',
          value: [{ field: 'f', value: 'v' }],
          ttlMs: 60_000,
        })
      ).ok,
    ).toBe(true);
    expect(await node.run(s, 'HGETALL', 'k')).toEqual({ map: [['f', 'v']] });
    const read = await browser.read(s, key('k'), q);
    expect(read.ok && read.value.ttlMs).toBe(60_000);
  });

  test('a failing command inside the transaction surfaces its error', async () => {
    const { browser, s } = await setup();
    const bad = await browser.write(s, key('k'), {
      type: 'zset',
      value: [{ member: 'm', score: Number.NaN }],
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });

  test('large collections are truncated to the limit and report their length', async () => {
    const { node, browser, s } = await setup();
    await node.run(s, 'RPUSH', 'l', ...Array.from({ length: 30 }, (_, i) => String(i)));
    const read = await browser.read(s, key('l'), keyQuerySchema.parse({ limit: 10 }));
    expect(read).toMatchObject({ ok: true, value: { length: 30, truncated: true } });
    expect(read.ok && read.value.value).toHaveLength(10);
  });

  test('binary values are returned as base64 and can be written back', async () => {
    const { browser, s } = await setup();
    const raw = Buffer.from([0xff, 0x00, 0xfe]).toString('base64');
    await browser.write(s, key('b'), { type: 'list', value: [raw], encoding: 'base64' });
    expect(await browser.read(s, key('b'), q)).toMatchObject({
      ok: true,
      value: { encoding: 'base64', value: [raw] },
    });
  });

  test('missing keys are NOT_FOUND for read, remove and setTtl', async () => {
    const { browser, s } = await setup();
    for (const r of [
      await browser.read(s, key('nope'), q),
      await browser.remove(s, key('nope')),
      await browser.setTtl(s, key('nope'), 1000),
      await browser.setTtl(s, key('nope'), null),
    ]) {
      expect(r).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    }
  });

  test('setTtl sets and clears expiry; remove deletes', async () => {
    const { node, browser, s } = await setup();
    await node.run(s, 'SET', 'k', 'v');
    expect((await browser.setTtl(s, key('k'), 5000)).ok).toBe(true);
    expect(await node.run(s, 'PTTL', 'k')).toBe(5000);
    expect((await browser.setTtl(s, key('k'), null)).ok).toBe(true);
    expect((await browser.setTtl(s, key('k'), null)).ok).toBe(true); // already persistent
    expect(await node.run(s, 'PTTL', 'k')).toBe(-1);
    expect((await browser.remove(s, key('k'))).ok).toBe(true);
    expect(await node.run(s, 'EXISTS', 'k')).toBe(0);
  });

  test('scan pages through every key with type, TTL and filters', async () => {
    const { node, browser, s } = await setup();
    for (let i = 0; i < 25; i++) await node.run(s, 'SET', `s:${i}`, 'v');
    await node.run(s, 'HSET', 'h:1', 'f', 'v');
    await node.run(s, 'PEXPIRE', 'h:1', '9000');
    const seen: string[] = [];
    let cursor = '0';
    do {
      const page = await browser.scan(s, scanQuerySchema.parse({ cursor, count: 7 }));
      if (!page.ok) throw new Error(page.error.message);
      seen.push(...page.value.keys.map((k) => k.key));
      cursor = page.value.cursor;
    } while (cursor !== '0');
    expect(new Set(seen).size).toBe(26);
    const hashes = await browser.scan(s, scanQuerySchema.parse({ type: 'hash', count: 1000 }));
    expect(hashes).toMatchObject({
      ok: true,
      value: { keys: [{ key: 'h:1', type: 'hash', ttlMs: 9000 }] },
    });
    const matched = await browser.scan(s, scanQuerySchema.parse({ match: 's:1*', count: 1000 }));
    expect(matched.ok && matched.value.keys.map((k) => k.key).sort()).toEqual([
      's:1',
      's:10',
      's:11',
      's:12',
      's:13',
      's:14',
      's:15',
      's:16',
      's:17',
      's:18',
      's:19',
    ]);
  });

  test('collections cannot be written empty', () => {
    expect(writeKeyBodySchema.safeParse({ type: 'set', value: [] }).success).toBe(false);
    expect(writeKeyBodySchema.safeParse({ type: 'string', value: '' }).success).toBe(true);
  });

  test('property: any UTF-8 hash survives write then read', async () => {
    const { browser, s } = await setup();
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ field: fc.string(), value: fc.string() }), {
          selector: (e) => e.field,
          minLength: 1,
          maxLength: 20,
        }),
        async (entries) => {
          await browser.write(s, key('p'), { type: 'hash', value: entries });
          const read = await browser.read(s, key('p'), q);
          if (!read.ok || read.value.type !== 'hash') return false;
          const sort = (a: { field: string }[]) =>
            [...a].sort((x, y) => (x.field < y.field ? -1 : 1));
          expect(sort(read.value.value)).toEqual(sort(entries));
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
