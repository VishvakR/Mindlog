import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Tuple } from '@mindlog/core';
import { encodeKey, keyPrefix } from '@mindlog/core';
import { MemoryStore, MvccReader, MvccWriter } from '@mindlog/storage';

const utf8 = new TextEncoder();
const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);
const k = (...tuple: Tuple) => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const prefix = (...tuple: Tuple) => {
  const r = keyPrefix('t', 'k', tuple);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

type Change = readonly [key: string, value: string | null];

/** Applies one batch of changes per index, starting at index 1. */
async function history(store: MemoryStore, commits: readonly (readonly Change[])[]) {
  for (const [i, changes] of commits.entries()) {
    const batch = store.batch();
    const writer = new MvccWriter(batch, BigInt(i + 1));
    for (const [key, value] of changes) {
      if (value === null) writer.delete(k('h', key));
      else writer.put(k('h', key), utf8.encode(value));
    }
    await batch.write();
  }
}

describe('MvccReader.get', () => {
  test('reads the newest version at or below the requested index', async () => {
    const store = new MemoryStore();
    await history(store, [[['a', 'v1']], [['a', 'v2']], [['a', null]], [['a', 'v4']]]);
    const reader = new MvccReader(store);
    expect(text(await reader.get(k('h', 'a'), 1n))).toBe('v1');
    expect(text(await reader.get(k('h', 'a'), 2n))).toBe('v2');
    expect(await reader.get(k('h', 'a'), 3n)).toBeUndefined();
    expect(text(await reader.get(k('h', 'a')))).toBe('v4');
    expect(await reader.get(k('h', 'a'), 0n)).toBeUndefined();
    expect((await reader.getVersioned(k('h', 'a')))?.index).toBe(4n);
  });

  test('ignores versions of keys that extend the requested key', async () => {
    const store = new MemoryStore();
    const batch = store.batch();
    new MvccWriter(batch, 1n).put(k('h', 'a', 'x'), utf8.encode('child'));
    await batch.write();
    expect(await new MvccReader(store).get(k('h', 'a'))).toBeUndefined();
  });
});

describe('MvccReader.scan', () => {
  test('collapses versions, hides tombstones and supports reverse, limit and cursors', async () => {
    const store = new MemoryStore();
    await history(store, [
      [
        ['a', '1'],
        ['b', '1'],
        ['c', '1'],
      ],
      [
        ['b', null],
        ['d', '2'],
      ],
      [['a', '3']],
    ]);
    const reader = new MvccReader(store);
    const scan = async (options = {}) => {
      const out: string[] = [];
      for await (const e of reader.scan(prefix('h'), options)) out.push(text(e.value) ?? '');
      return out.join(',');
    };
    expect(await scan()).toBe('3,1,2');
    expect(await scan({ at: 1n })).toBe('1,1,1');
    expect(await scan({ reverse: true })).toBe('2,1,3');
    expect(await scan({ reverse: true, at: 2n })).toBe('2,1,1');
    expect(await scan({ limit: 2 })).toBe('3,1');
    expect(await scan({ after: k('h', 'a') })).toBe('1,2');
    expect(await scan({ before: k('h', 'c') })).toBe('3');
    expect(await scan({ from: k('h', 'c') })).toBe('1,2');
  });

  test('matches a model of every key at every index', async () => {
    const change = fc.tuple(
      fc.constantFrom('a', 'b', 'c', 'd'),
      fc.option(fc.string({ maxLength: 3 })),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(change, { maxLength: 3 }), { maxLength: 8 }),
        async (commits) => {
          const store = new MemoryStore();
          await history(store, commits);
          const reader = new MvccReader(store);
          const model = new Map<string, string>();
          for (const [i, changes] of commits.entries()) {
            for (const [key, value] of changes) {
              if (value === null) model.delete(key);
              else model.set(key, value);
            }
            const at = BigInt(i + 1);
            const scanned: string[] = [];
            for await (const e of reader.scan(prefix('h'), { at }))
              scanned.push(text(e.value) ?? '');
            const expected = [...model.keys()].sort().map((key) => model.get(key) ?? '');
            expect(scanned).toEqual(expected);
            for (const key of ['a', 'b', 'c', 'd']) {
              expect(text(await reader.get(k('h', key), at))).toBe(model.get(key));
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
