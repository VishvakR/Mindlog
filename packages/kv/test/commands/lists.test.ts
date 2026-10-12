import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

describe('lists (Valkey list.tcl)', () => {
  test('LPUSH, RPUSH, LLENGTH, LINDEX, LPOP', async () => {
    expect(await node.run('LPUSH', 'l', 'a')).toBe(1);
    expect(await node.run('RPUSH', 'l', 'b')).toBe(2);
    expect(await node.run('LPUSH', 'l', 'c', 'd')).toBe(4);
    expect(await node.run('LRANGE', 'l', '0', '-1')).toEqual(['d', 'c', 'a', 'b']);
    expect(await node.run('LLEN', 'l')).toBe(4);
    expect(await node.run('LINDEX', 'l', '0')).toBe('d');
    expect(await node.run('LINDEX', 'l', '-1')).toBe('b');
    expect(await node.run('LINDEX', 'l', '100')).toBeNull();
    expect(await node.run('LPOP', 'l')).toBe('d');
    expect(await node.run('RPOP', 'l')).toBe('b');
    expect(await node.run('LRANGE', 'l', '0', '-1')).toEqual(['c', 'a']);
    expect(await node.run('TYPE', 'l')).toBe('list');
  });

  test('LPOP/RPOP with count', async () => {
    await node.run('RPUSH', 'l', 'a', 'b', 'c');
    expect(await node.run('LPOP', 'l', '2')).toEqual(['a', 'b']);
    expect(await node.run('RPOP', 'l', '5')).toEqual(['c']);
    expect(await node.run('EXISTS', 'l')).toBe(0);
    expect(await node.run('LPOP', 'l', '2')).toBeNull();
    expect(await node.run('LPOP', 'l', '-1')).toEqual({
      error: 'INVALID_ARGUMENT value is out of range, must be positive',
    });
  });

  test('LPUSHX / RPUSHX only push onto existing lists', async () => {
    expect(await node.run('LPUSHX', 'l', 'a')).toBe(0);
    expect(await node.run('EXISTS', 'l')).toBe(0);
    await node.run('RPUSH', 'l', 'a');
    expect(await node.run('RPUSHX', 'l', 'b', 'c')).toBe(3);
  });

  test('LRANGE out of range and negative indexes', async () => {
    await node.run('RPUSH', 'l', '1', '2', '3', '4', '5');
    expect(await node.run('LRANGE', 'l', '1', '-2')).toEqual(['2', '3', '4']);
    expect(await node.run('LRANGE', 'l', '-3', '-1')).toEqual(['3', '4', '5']);
    expect(await node.run('LRANGE', 'l', '-100', '1')).toEqual(['1', '2']);
    expect(await node.run('LRANGE', 'l', '3', '1')).toEqual([]);
    expect(await node.run('LRANGE', 'l', '10', '20')).toEqual([]);
    expect(await node.run('LRANGE', 'missing', '0', '-1')).toEqual([]);
  });

  test('LSET', async () => {
    await node.run('RPUSH', 'l', 'a', 'b');
    expect(await node.run('LSET', 'l', '-1', 'z')).toBe('OK');
    expect(await node.run('LRANGE', 'l', '0', '-1')).toEqual(['a', 'z']);
    expect(await node.run('LSET', 'l', '5', 'x')).toEqual({
      error: 'INVALID_ARGUMENT index out of range',
    });
    expect(await node.run('LSET', 'missing', '0', 'x')).toEqual({
      error: 'INVALID_ARGUMENT no such key',
    });
  });

  test('LTRIM basics and trimming to nothing deletes the key', async () => {
    await node.run('RPUSH', 'l', '1', '2', '3', '4', '5');
    expect(await node.run('LTRIM', 'l', '1', '-2')).toBe('OK');
    expect(await node.run('LRANGE', 'l', '0', '-1')).toEqual(['2', '3', '4']);
    await node.run('LTRIM', 'l', '5', '10');
    expect(await node.run('EXISTS', 'l')).toBe(0);
  });

  test('a re-created list does not see old elements', async () => {
    await node.run('RPUSH', 'l', 'a', 'b');
    await node.run('DEL', 'l');
    await node.run('RPUSH', 'l', 'c');
    expect(await node.run('LRANGE', 'l', '0', '-1')).toEqual(['c']);
  });

  test('random push/pop/trim sequences match an array model', async () => {
    const op = fc.oneof(
      fc.tuple(fc.constantFrom('LPUSH', 'RPUSH'), fc.integer({ min: 0, max: 99 }).map(String)),
      fc.tuple(fc.constantFrom('LPOP', 'RPOP'), fc.constant('')),
      fc.tuple(
        fc.constant('LTRIM'),
        fc.tuple(fc.integer({ min: -4, max: 4 }), fc.integer({ min: -4, max: 4 })),
      ),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 20 }), async (ops) => {
        const n = await kvNode(createKvRegistry());
        let model: string[] = [];
        for (const [verb, arg] of ops) {
          if (verb === 'LPUSH') model.unshift(arg);
          else if (verb === 'RPUSH') model.push(arg);
          else if (verb === 'LPOP') model.shift();
          else if (verb === 'RPOP') model.pop();
          if (verb === 'LTRIM') {
            const [a, b] = arg;
            const len = model.length;
            const from = Math.max(a < 0 ? len + a : a, 0);
            const to = Math.min(b < 0 ? len + b : b, len - 1);
            model = from > to ? [] : model.slice(from, to + 1);
            await n.run('LTRIM', 'l', String(a), String(b));
          } else if (verb === 'LPOP' || verb === 'RPOP') {
            await n.run(verb, 'l');
          } else {
            await n.run(verb, 'l', arg);
          }
          expect(await n.run('LRANGE', 'l', '0', '-1')).toEqual(model);
        }
        expect(await n.run('LLEN', 'l')).toBe(model.length);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
