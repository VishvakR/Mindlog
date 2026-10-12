import fc from 'fast-check';
import { beforeEach, describe, expect, test } from 'vitest';
import { createKvRegistry } from '@mindlog/kv';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});
const sorted = (r: unknown) => [...(r as string[])].sort();

describe('sets (Valkey set.tcl)', () => {
  test('SADD, SCARD, SISMEMBER, SMISMEMBER, SMEMBERS, SREM', async () => {
    expect(await node.run('SADD', 's', 'a', 'b', 'a')).toBe(2);
    expect(await node.run('SADD', 's', 'c')).toBe(1);
    expect(await node.run('SCARD', 's')).toBe(3);
    expect(await node.run('SISMEMBER', 's', 'a')).toBe(1);
    expect(await node.run('SISMEMBER', 's', 'z')).toBe(0);
    expect(await node.run('SMISMEMBER', 's', 'a', 'z')).toEqual([1, 0]);
    expect(sorted(await node.run('SMEMBERS', 's'))).toEqual(['a', 'b', 'c']);
    expect(await node.run('SREM', 's', 'a', 'z')).toBe(1);
    expect(await node.run('TYPE', 's')).toBe('set');
    expect(await node.run('SREM', 's', 'b', 'c')).toBe(2);
    expect(await node.run('EXISTS', 's')).toBe(0);
  });

  test('SINTER, SUNION, SDIFF against existing and missing keys', async () => {
    await node.run('SADD', 's1', '1', '2', '3');
    await node.run('SADD', 's2', '2', '3', '4');
    expect(sorted(await node.run('SINTER', 's1', 's2'))).toEqual(['2', '3']);
    expect(sorted(await node.run('SUNION', 's1', 's2', 'missing'))).toEqual(['1', '2', '3', '4']);
    expect(sorted(await node.run('SDIFF', 's1', 's2'))).toEqual(['1']);
    expect(await node.run('SINTER', 's1', 'missing')).toEqual([]);
    await node.run('SET', 'str', 'x');
    expect(await node.run('SUNION', 's1', 'str')).toEqual({
      error: 'WRONG_TYPE Operation against a key holding the wrong kind of value',
    });
  });

  test('SPOP removes random members, reproducibly per log index', async () => {
    await node.run('SADD', 's', 'a', 'b', 'c', 'd', 'e');
    const popped = (await node.run('SPOP', 's', '2')) as string[];
    expect(popped).toHaveLength(2);
    expect(await node.run('SCARD', 's')).toBe(3);
    for (const member of popped) expect(await node.run('SISMEMBER', 's', member)).toBe(0);
    const single = (await node.run('SPOP', 's')) as string;
    expect(['a', 'b', 'c', 'd', 'e']).toContain(single);
    expect(await node.run('SPOP', 'missing')).toBeNull();
    expect(await node.run('SPOP', 'missing', '2')).toEqual([]);

    const again = await kvNode(createKvRegistry());
    await again.run('SADD', 's', 'a', 'b', 'c', 'd', 'e');
    expect(await again.run('SPOP', 's', '2')).toEqual(popped);
  });

  test('SRANDMEMBER with positive (distinct) and negative (repeating) counts', async () => {
    await node.run('SADD', 's', 'a', 'b', 'c');
    expect(new Set((await node.run('SRANDMEMBER', 's', '10')) as string[]).size).toBe(3);
    expect(await node.run('SRANDMEMBER', 's', '-7')).toHaveLength(7);
    expect(['a', 'b', 'c']).toContain(await node.run('SRANDMEMBER', 's'));
    expect(await node.run('SCARD', 's')).toBe(3);
    expect(await node.run('SRANDMEMBER', 'missing')).toBeNull();
  });

  test('SSCAN visits every member once', async () => {
    await node.run('SADD', 's', ...Array.from({ length: 30 }, (_, i) => `m${i}`));
    const seen: string[] = [];
    let cursor = '0';
    do {
      const [next, items] = (await node.run('SSCAN', 's', cursor, 'COUNT', '7')) as [
        string,
        string[],
      ];
      seen.push(...items);
      cursor = next;
    } while (cursor !== '0');
    expect(seen.sort()).toEqual(Array.from({ length: 30 }, (_, i) => `m${i}`).sort());
  });

  test('random SADD / SREM sequences match a Set', async () => {
    const op = fc.tuple(
      fc.constantFrom('SADD', 'SREM'),
      fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { minLength: 1, maxLength: 3 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 15 }), async (ops) => {
        const n = await kvNode(createKvRegistry());
        const model = new Set<string>();
        for (const [verb, members] of ops) {
          const before = model.size;
          for (const m of members) {
            if (verb === 'SADD') model.add(m);
            else model.delete(m);
          }
          const changed = Math.abs(model.size - before);
          expect(await n.run(verb, 's', ...members)).toBe(changed);
        }
        expect(sorted(await n.run('SMEMBERS', 's'))).toEqual([...model].sort());
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
