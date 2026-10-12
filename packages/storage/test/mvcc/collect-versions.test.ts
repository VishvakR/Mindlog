import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { encodeKey, keyPrefix } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader, MvccWriter, collectVersions } from '@mindlog/storage';

const utf8 = new TextEncoder();
const key = (name: string) => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: [name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const prefix = (() => {
  const r = keyPrefix('t', 'k');
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

async function rawCount(store: KvStore): Promise<number> {
  let n = 0;
  const end = new Uint8Array([...prefix, 0xff]);
  for await (const _ of store.iterate({ start: prefix, end })) n++;
  return n;
}

async function gcAll(store: KvStore, belowIndex: bigint, limit: number): Promise<number> {
  let after: Uint8Array | undefined;
  let total = 0;
  for (;;) {
    const batch = store.batch();
    const r = await collectVersions(
      store,
      batch,
      prefix,
      after ? { belowIndex, limit, after } : { belowIndex, limit },
    );
    await batch.write();
    total += r.removed;
    if (!r.resumeAfter) return total;
    after = r.resumeAfter;
  }
}

describe('collectVersions', () => {
  test('keeps the newest version below the threshold and everything above it', async () => {
    const store = new MemoryStore();
    for (const [i, v] of ['v1', 'v2', 'v3', 'v4'].entries()) {
      const batch = store.batch();
      new MvccWriter(batch, BigInt(i + 1)).put(key('a'), utf8.encode(v));
      await batch.write();
    }
    expect(await gcAll(store, 3n, 100)).toBe(1);
    const reader = new MvccReader(store);
    expect(await reader.get(key('a'), 2n)).toEqual(utf8.encode('v2'));
    expect(await reader.get(key('a'), 1n)).toBeUndefined();
    expect(await rawCount(store)).toBe(3);
  });

  test('drops a deleted key entirely once its tombstone is below the threshold', async () => {
    const store = new MemoryStore();
    const b1 = store.batch();
    new MvccWriter(b1, 1n).put(key('a'), utf8.encode('x'));
    await b1.write();
    const b2 = store.batch();
    new MvccWriter(b2, 2n).delete(key('a'));
    await b2.write();
    expect(await gcAll(store, 5n, 100)).toBe(2);
    expect(await rawCount(store)).toBe(0);
  });

  test('reads at or above the threshold are unchanged, whatever the batch size', async () => {
    const change = fc.tuple(fc.constantFrom('a', 'b', 'c'), fc.option(fc.string({ maxLength: 2 })));
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(change, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 1, max: 4 }),
        async (commits, threshold, limit) => {
          const store = new MemoryStore();
          for (const [i, changes] of commits.entries()) {
            const batch = store.batch();
            const writer = new MvccWriter(batch, BigInt(i + 1));
            for (const [name, value] of changes) {
              if (value === null) writer.delete(key(name));
              else writer.put(key(name), utf8.encode(value));
            }
            await batch.write();
          }
          const reader = new MvccReader(store);
          const snapshot = async () => {
            const out: string[] = [];
            for (let at = BigInt(threshold); at <= BigInt(commits.length) + 1n; at++) {
              for await (const e of reader.scan(prefix, { at }))
                out.push(`${at}:${e.value.join('.')}`);
            }
            return out;
          };
          const before = await snapshot();
          await gcAll(store, BigInt(threshold), limit);
          expect(await snapshot()).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});
