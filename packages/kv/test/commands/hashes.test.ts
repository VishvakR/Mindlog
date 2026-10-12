import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

const WRONGTYPE = { error: 'WRONG_TYPE Operation against a key holding the wrong kind of value' };
let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

const sortedMap = (r: unknown) =>
  (r as { map: [string, string][] }).map.slice().sort(([a], [b]) => (a < b ? -1 : 1));

describe('hashes (Valkey hash.tcl)', () => {
  test('HSET / HGET / HLEN / HEXISTS / HSTRLEN', async () => {
    expect(await node.run('HSET', 'h', 'a', '1', 'b', '22')).toBe(2);
    expect(await node.run('HSET', 'h', 'a', 'x', 'c', '3')).toBe(1);
    expect(await node.run('HGET', 'h', 'a')).toBe('x');
    expect(await node.run('HGET', 'h', 'missing')).toBeNull();
    expect(await node.run('HLEN', 'h')).toBe(3);
    expect(await node.run('HEXISTS', 'h', 'b')).toBe(1);
    expect(await node.run('HEXISTS', 'h', 'z')).toBe(0);
    expect(await node.run('HSTRLEN', 'h', 'b')).toBe(2);
    expect(await node.run('TYPE', 'h')).toBe('hash');
  });

  test('HMSET, HSETNX and HMGET', async () => {
    expect(await node.run('HMSET', 'h', 'a', '1', 'b', '2')).toBe('OK');
    expect(await node.run('HSETNX', 'h', 'a', 'x')).toBe(0);
    expect(await node.run('HSETNX', 'h', 'c', '3')).toBe(1);
    expect(await node.run('HMGET', 'h', 'a', 'z', 'c')).toEqual(['1', null, '3']);
    expect(await node.run('HMGET', 'missing', 'a')).toEqual([null]);
    expect(await node.run('HSET', 'h', 'a')).toEqual({
      error: "INVALID_ARGUMENT wrong number of arguments for 'hset' command",
    });
  });

  test('HGETALL / HKEYS / HVALS', async () => {
    await node.run('HSET', 'h', 'b', '2', 'a', '1');
    expect(sortedMap(await node.run('HGETALL', 'h'))).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
    expect(await node.run('HKEYS', 'h')).toEqual(['a', 'b']);
    expect(await node.run('HVALS', 'h')).toEqual(['1', '2']);
    expect(await node.run('HGETALL', 'missing')).toEqual({ map: [] });
  });

  test('HDEL removes fields and deletes the key when it empties', async () => {
    await node.run('HSET', 'h', 'a', '1', 'b', '2');
    expect(await node.run('HDEL', 'h', 'a', 'z')).toBe(1);
    expect(await node.run('HDEL', 'h', 'b')).toBe(1);
    expect(await node.run('EXISTS', 'h')).toBe(0);
    expect(await node.run('HDEL', 'h', 'b')).toBe(0);
  });

  test('HINCRBY and HINCRBYFLOAT', async () => {
    expect(await node.run('HINCRBY', 'h', 'n', '5')).toBe(5);
    expect(await node.run('HINCRBY', 'h', 'n', '-7')).toBe(-2);
    await node.run('HSET', 'h', 's', 'abc');
    expect(await node.run('HINCRBY', 'h', 's', '1')).toEqual({
      error: 'INVALID_ARGUMENT hash value is not an integer',
    });
    expect(await node.run('HINCRBYFLOAT', 'h', 'f', '1.5')).toBe('1.5');
    expect(await node.run('HINCRBYFLOAT', 'h', 's', '1')).toEqual({
      error: 'INVALID_ARGUMENT hash value is not a float',
    });
    await node.run('HSET', 'h', 'max', '9223372036854775807');
    expect(await node.run('HINCRBY', 'h', 'max', '1')).toEqual({
      error: 'INVALID_ARGUMENT increment or decrement would overflow',
    });
  });

  test('WRONGTYPE between strings and hashes', async () => {
    await node.run('SET', 's', 'v');
    expect(await node.run('HSET', 's', 'f', 'v')).toEqual(WRONGTYPE);
    expect(await node.run('HGET', 's', 'f')).toEqual(WRONGTYPE);
    await node.run('HSET', 'h', 'f', 'v');
    expect(await node.run('GET', 'h')).toEqual(WRONGTYPE);
    expect(await node.run('INCR', 'h')).toEqual(WRONGTYPE);
    expect(await node.run('SET', 'h', 'v')).toBe('OK');
    expect(await node.run('GET', 'h')).toBe('v');
  });

  test('a deleted, expired or overwritten hash never revives old fields', async () => {
    await node.run('HSET', 'h', 'a', '1', 'b', '2');
    await node.run('DEL', 'h');
    await node.run('HSET', 'h', 'c', '3');
    expect(await node.run('HKEYS', 'h')).toEqual(['c']);
    expect(await node.run('HLEN', 'h')).toBe(1);

    await node.run('PEXPIRE', 'h', '1');
    node.clock.advance(2n);
    await node.run('HSET', 'h', 'd', '4');
    expect(await node.run('HKEYS', 'h')).toEqual(['d']);

    await node.run('SET', 'h', 'string now');
    await node.run('DEL', 'h');
    await node.run('HSET', 'h', 'e', '5');
    expect(await node.run('HKEYS', 'h')).toEqual(['e']);
  });

  test('RENAME moves every field and the source is gone', async () => {
    await node.run('HSET', 'src', 'a', '1', 'b', '2');
    await node.run('HSET', 'dst', 'old', 'x');
    expect(await node.run('RENAME', 'src', 'dst')).toBe('OK');
    expect(await node.run('HKEYS', 'dst')).toEqual(['a', 'b']);
    expect(await node.run('HLEN', 'dst')).toBe(2);
    expect(await node.run('EXISTS', 'src')).toBe(0);
    await node.run('HSET', 'src', 'z', '9');
    expect(await node.run('HKEYS', 'src')).toEqual(['z']);
  });

  test('fields may contain zero bytes and arbitrary binary data', async () => {
    const field = new Uint8Array([0x61, 0x00, 0xff, 0x00]);
    await node.run('HSET', 'h', field, 'bin');
    const keys = await node.raw('HKEYS', 'h');
    expect(keys.kind.case === 'array' && keys.kind.value.items[0]?.kind.value).toEqual(field);
    expect(await node.run('HGET', 'h', field)).toBe('bin');
  });

  test('HSCAN walks every field once, with MATCH and NOVALUES', async () => {
    const pairs = Array.from({ length: 25 }, (_, i) => [`f${i}`, `v${i}`]).flat();
    await node.run('HSET', 'h', ...pairs);
    const seen: string[] = [];
    let cursor = '0';
    do {
      const [next, items] = (await node.run('HSCAN', 'h', cursor, 'COUNT', '4')) as [
        string,
        string[],
      ];
      for (let i = 0; i < items.length; i += 2) seen.push(`${items[i]}=${items[i + 1]}`);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.sort()).toEqual(Array.from({ length: 25 }, (_, i) => `f${i}=v${i}`).sort());
    const [, matched] = (await node.run(
      'HSCAN',
      'h',
      '0',
      'MATCH',
      'f1*',
      'COUNT',
      '100',
      'NOVALUES',
    )) as [string, string[]];
    expect(matched.sort()).toEqual([
      'f1',
      'f10',
      'f11',
      'f12',
      'f13',
      'f14',
      'f15',
      'f16',
      'f17',
      'f18',
      'f19',
    ]);
  });

  test('random HSET / HDEL / HINCRBY sequences match a Map', async () => {
    const op = fc.oneof(
      fc.tuple(
        fc.constant('HSET'),
        fc.constantFrom('a', 'b', 'c'),
        fc.integer({ min: 0, max: 9 }).map(String),
      ),
      fc.tuple(fc.constant('HDEL'), fc.constantFrom('a', 'b', 'c'), fc.constant('')),
      fc.tuple(
        fc.constant('HINCRBY'),
        fc.constantFrom('a', 'b', 'c'),
        fc.integer({ min: -3, max: 3 }).map(String),
      ),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 15 }), async (ops) => {
        const n = await kvNode(createKvRegistry());
        const model = new Map<string, string>();
        for (const [verb, field, arg] of ops) {
          if (verb === 'HSET') {
            model.set(field, arg);
            await n.run('HSET', 'h', field, arg);
          } else if (verb === 'HDEL') {
            model.delete(field);
            await n.run('HDEL', 'h', field);
          } else {
            model.set(field, String(Number(model.get(field) ?? '0') + Number(arg)));
            await n.run('HINCRBY', 'h', field, arg);
          }
        }
        const expected = [...model.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
        expect(sortedMap(await n.run('HGETALL', 'h'))).toEqual(expected);
        expect(await n.run('HLEN', 'h')).toBe(model.size);
        expect(await n.run('EXISTS', 'h')).toBe(model.size > 0 ? 1 : 0);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
