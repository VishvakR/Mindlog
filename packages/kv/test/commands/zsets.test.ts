import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

async function seed() {
  await node.run('ZADD', 'z', '1', 'a', '2', 'b', '3', 'c', '4', 'd');
}

describe('sorted sets (Valkey zset.tcl)', () => {
  test('ZADD basics, ZSCORE, ZCARD, TYPE', async () => {
    expect(await node.run('ZADD', 'z', '10', 'x', '20', 'y')).toBe(2);
    expect(await node.run('ZADD', 'z', '30', 'x')).toBe(0);
    expect(await node.run('ZSCORE', 'z', 'x')).toBe(30);
    expect(await node.run('ZSCORE', 'z', 'missing')).toBeNull();
    expect(await node.run('ZCARD', 'z')).toBe(2);
    expect(await node.run('TYPE', 'z')).toBe('zset');
  });

  test('ZADD NX / XX / GT / LT / CH / INCR', async () => {
    await node.run('ZADD', 'z', '10', 'x');
    expect(await node.run('ZADD', 'z', 'NX', '1', 'x', '5', 'y')).toBe(1);
    expect(await node.run('ZSCORE', 'z', 'x')).toBe(10);
    expect(await node.run('ZADD', 'z', 'XX', '11', 'x', '7', 'new')).toBe(0);
    expect(await node.run('ZSCORE', 'z', 'x')).toBe(11);
    expect(await node.run('ZADD', 'z', 'XX', 'CH', '12', 'x')).toBe(1);
    expect(await node.run('ZADD', 'z', 'GT', 'CH', '1', 'x')).toBe(0);
    expect(await node.run('ZADD', 'z', 'LT', 'CH', '1', 'x')).toBe(1);
    expect(await node.run('ZADD', 'z', 'INCR', '5', 'x')).toBe(6);
    expect(await node.run('ZADD', 'z', 'NX', 'INCR', '5', 'x')).toBeNull();
  });

  test('ZADD option and argument errors', async () => {
    expect(await node.run('ZADD', 'z', 'NX', 'XX', '1', 'a')).toEqual({
      error: 'INVALID_ARGUMENT XX and NX options at the same time are not compatible',
    });
    expect(await node.run('ZADD', 'z', 'GT', 'LT', '1', 'a')).toEqual({
      error: 'INVALID_ARGUMENT GT, LT, and/or NX options at the same time are not compatible',
    });
    expect(await node.run('ZADD', 'z', 'INCR', '1', 'a', '2', 'b')).toEqual({
      error: 'INVALID_ARGUMENT INCR option supports a single increment-element pair',
    });
    expect(await node.run('ZADD', 'z', 'abc', 'a')).toEqual({
      error: 'INVALID_ARGUMENT value is not a valid float',
    });
    expect(await node.run('ZADD', 'z', '1', 'a', '2')).toEqual({
      error: 'INVALID_ARGUMENT syntax error',
    });
  });

  test('ZRANGE by rank, reversed, with scores', async () => {
    await seed();
    expect(await node.run('ZRANGE', 'z', '0', '-1')).toEqual(['a', 'b', 'c', 'd']);
    expect(await node.run('ZRANGE', 'z', '1', '2')).toEqual(['b', 'c']);
    expect(await node.run('ZRANGE', 'z', '0', '1', 'REV')).toEqual(['d', 'c']);
    expect(await node.run('ZREVRANGE', 'z', '0', '1')).toEqual(['d', 'c']);
    expect(await node.run('ZRANGE', 'z', '0', '1', 'WITHSCORES')).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(await node.run('ZRANGE', 'z', '5', '10')).toEqual([]);
  });

  test('ZRANGEBYSCORE with inclusive/exclusive bounds, infinity and LIMIT', async () => {
    await seed();
    expect(await node.run('ZRANGEBYSCORE', 'z', '2', '3')).toEqual(['b', 'c']);
    expect(await node.run('ZRANGEBYSCORE', 'z', '(2', '3')).toEqual(['c']);
    expect(await node.run('ZRANGEBYSCORE', 'z', '-inf', '(3')).toEqual(['a', 'b']);
    expect(await node.run('ZRANGE', 'z', '+inf', '2', 'BYSCORE', 'REV')).toEqual(['d', 'c', 'b']);
    expect(await node.run('ZREVRANGEBYSCORE', 'z', '4', '(1')).toEqual(['d', 'c', 'b']);
    expect(await node.run('ZRANGEBYSCORE', 'z', '-inf', '+inf', 'LIMIT', '1', '2')).toEqual([
      'b',
      'c',
    ]);
    expect(await node.run('ZRANGEBYSCORE', 'z', 'x', '1')).toEqual({
      error: 'INVALID_ARGUMENT min or max is not a float',
    });
    expect(await node.run('ZRANGE', 'z', '0', '1', 'LIMIT', '0', '1')).toEqual({
      error:
        'INVALID_ARGUMENT syntax error, LIMIT is only supported in combination with either BYSCORE or BYLEX',
    });
  });

  test('ZRANGEBYLEX on equal scores', async () => {
    await node.run('ZADD', 'l', '0', 'alpha', '0', 'bar', '0', 'cool', '0', 'down');
    expect(await node.run('ZRANGEBYLEX', 'l', '-', '+')).toEqual(['alpha', 'bar', 'cool', 'down']);
    expect(await node.run('ZRANGEBYLEX', 'l', '[bar', '(down')).toEqual(['bar', 'cool']);
    expect(await node.run('ZREVRANGEBYLEX', 'l', '+', '(bar')).toEqual(['down', 'cool']);
    expect(await node.run('ZRANGE', 'l', '[b', '[d', 'BYLEX', 'LIMIT', '0', '1')).toEqual(['bar']);
    expect(await node.run('ZRANGEBYLEX', 'l', 'bad', '+')).toEqual({
      error: 'INVALID_ARGUMENT min or max not valid string range item',
    });
  });

  test('ZCOUNT, ZRANK, ZREVRANK, ZMSCORE', async () => {
    await seed();
    expect(await node.run('ZCOUNT', 'z', '(1', '3')).toBe(2);
    expect(await node.run('ZRANK', 'z', 'c')).toBe(2);
    expect(await node.run('ZREVRANK', 'z', 'c')).toBe(1);
    expect(await node.run('ZRANK', 'z', 'c', 'WITHSCORE')).toEqual([2, 3]);
    expect(await node.run('ZRANK', 'z', 'missing')).toBeNull();
    expect(await node.run('ZMSCORE', 'z', 'a', 'zz')).toEqual([1, null]);
  });

  test('ZINCRBY, ZREM and ZPOPMIN/ZPOPMAX', async () => {
    await seed();
    expect(await node.run('ZINCRBY', 'z', '10', 'a')).toBe(11);
    expect(await node.run('ZRANGE', 'z', '0', '-1')).toEqual(['b', 'c', 'd', 'a']);
    expect(await node.run('ZREM', 'z', 'b', 'missing')).toBe(1);
    expect(await node.run('ZPOPMIN', 'z')).toEqual(['c', 3]);
    expect(await node.run('ZPOPMAX', 'z', '5')).toEqual([
      ['a', 11],
      ['d', 4],
    ]);
    expect(await node.run('EXISTS', 'z')).toBe(0);
  });

  test('ties order by member, infinities and -0 behave', async () => {
    await node.run('ZADD', 'z', '1', 'b', '1', 'a', '-inf', 'low', '+inf', 'high', '-0', 'zero');
    expect(await node.run('ZRANGE', 'z', '0', '-1')).toEqual(['low', 'zero', 'a', 'b', 'high']);
    expect(await node.run('ZSCORE', 'z', 'zero')).toBe(0);
  });

  test('random ZADD/ZREM sequences match a model sorted by (score, member)', async () => {
    const op = fc.oneof(
      fc.tuple(
        fc.constant('ZADD'),
        fc.constantFrom('a', 'b', 'c', 'd'),
        fc.integer({ min: -3, max: 3 }),
      ),
      fc.tuple(fc.constant('ZREM'), fc.constantFrom('a', 'b', 'c', 'd'), fc.constant(0)),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 15 }), async (ops) => {
        const n = await kvNode(createKvRegistry());
        const model = new Map<string, number>();
        for (const [verb, member, score] of ops) {
          if (verb === 'ZADD') {
            model.set(member, score);
            await n.run('ZADD', 'z', String(score), member);
          } else {
            model.delete(member);
            await n.run('ZREM', 'z', member);
          }
        }
        const expected = [...model.entries()]
          .sort(([ma, sa], [mb, sb]) => sa - sb || (ma < mb ? -1 : ma > mb ? 1 : 0))
          .map(([m]) => m);
        expect(await n.run('ZRANGE', 'z', '0', '-1')).toEqual(expected);
        expect(await n.run('ZCARD', 'z')).toBe(model.size);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
