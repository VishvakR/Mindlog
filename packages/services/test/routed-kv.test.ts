import { describe, expect, test } from 'vitest';
import { twoRanges } from './support/two-ranges.js';

describe('KvService over two ranges (ADR-0029)', () => {
  test("single-key commands run on the key's range", async () => {
    const { run } = await twoRanges();
    expect(await run('SET', 'apple', '1')).toBe('OK');
    expect(await run('SET', 'zebra', '2')).toBe('OK');
    expect(await run('GET', 'apple')).toBe('1');
    expect(await run('GET', 'zebra')).toBe('2');
    expect(await run('INCR', 'zebra')).toBe(3);
  });

  test('MGET and the counting commands fan out and merge in input order', async () => {
    const { run } = await twoRanges();
    await run('SET', 'apple', '1');
    await run('SET', 'zebra', '2');
    await run('SET', 'mango', '3');
    expect(await run('MGET', 'zebra', 'nothing', 'apple', 'mango')).toEqual(['2', null, '1', '3']);
    expect(await run('EXISTS', 'apple', 'zebra', 'zebra', 'gone')).toBe(3);
    expect(await run('DEL', 'apple', 'zebra', 'gone')).toBe(2);
    expect(await run('MGET', 'apple', 'zebra')).toEqual([null, null]);
  });

  test('other multi-key writes across ranges are refused with CROSS_RANGE', async () => {
    const { run } = await twoRanges();
    expect(await run('MSET', 'apple', '1', 'zebra', '2')).toEqual({
      error: "CROSS_RANGE Keys in request don't hash to the same slot",
    });
    expect(await run('RENAME', 'apple', 'zebra')).toMatchObject({
      error: expect.stringMatching(/^CROSS_RANGE/) as string,
    });
    expect(await run('MSET', 'apple', '1', 'banana', '2')).toBe('OK');
  });

  test('MULTI/EXEC runs in the one range that holds every key, and not across ranges', async () => {
    const { run } = await twoRanges();
    await run('MULTI');
    expect(await run('SET', 'apple', '1')).toBe('QUEUED');
    expect(await run('INCR', 'apple')).toBe('QUEUED');
    expect(await run('EXEC')).toEqual(['OK', 2]);
    await run('MULTI');
    await run('SET', 'apple', '1');
    await run('SET', 'zebra', '1');
    expect(await run('EXEC')).toMatchObject({
      error: expect.stringMatching(/^CROSS_RANGE/) as string,
    });
  });

  test("WATCH records the version in the key's range, and EXEC aborts if it moved", async () => {
    const { run } = await twoRanges();
    await run('SET', 'zebra', '1');
    expect(await run('WATCH', 'zebra')).toBe('OK');
    await run('SET', 'zebra', '2');
    await run('MULTI');
    await run('SET', 'zebra', '3');
    expect(await run('EXEC')).toBeNull();
    expect(await run('GET', 'zebra')).toBe('2');
  });

  test('DBSIZE, KEYS and SCAN cover every range, and SCAN resumes across them', async () => {
    const { run } = await twoRanges();
    for (const k of ['a', 'b', 'c', 'x', 'y', 'z']) await run('SET', k, k);
    expect(await run('DBSIZE')).toBe(6);
    expect(((await run('KEYS', '*')) as string[]).sort()).toEqual(['a', 'b', 'c', 'x', 'y', 'z']);
    const seen: string[] = [];
    let cursor = '0';
    for (let i = 0; i < 20; i++) {
      const [next, keys] = (await run('SCAN', cursor, 'COUNT', '2')) as [string, string[]];
      seen.push(...keys);
      cursor = next;
      if (cursor === '0') break;
    }
    expect([...new Set(seen)].sort()).toEqual(['a', 'b', 'c', 'x', 'y', 'z']);
    expect(seen.length).toBeLessThan(12);
  });

  test("a range this node does not hold is reached through the router's forward", async () => {
    const { run, forwarded } = await twoRanges({ remoteRange2: true });
    expect(await run('SET', 'zebra', '2')).toBe('OK');
    expect(await run('GET', 'zebra')).toBe('2');
    expect(await run('SET', 'apple', '1')).toBe('OK');
    expect(forwarded.map((f) => f.rangeId)).toEqual([2n, 2n]);
    expect(await run('MGET', 'apple', 'zebra')).toEqual(['1', '2']);
    expect(await run('DBSIZE')).toBe(2);
    await run('WATCH', 'zebra');
    await run('MULTI');
    await run('INCR', 'zebra');
    expect(await run('EXEC')).toEqual([3]);
    expect(forwarded.some((f) => f.call.kind === 'batch')).toBe(true);
    expect(forwarded.some((f) => f.call.kind === 'watch')).toBe(true);
  });
});
