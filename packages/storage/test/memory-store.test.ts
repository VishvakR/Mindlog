import { describe, expect, test } from 'vitest';
import { MemoryStore } from '@mindlog/storage';
import { b, collect, describeKvStoreContract } from './contracts/kv-store-contract.js';

describeKvStoreContract('MemoryStore', () => Promise.resolve(new MemoryStore()));

describe('MemoryStore', () => {
  test('an iteration in progress keeps its view while writes land', async () => {
    const store = new MemoryStore();
    const batch = store.batch();
    batch.put(b(1), b(1));
    batch.put(b(2), b(2));
    await batch.write();
    const seen: number[][] = [];
    for await (const [key] of store.iterate({ start: b(0), end: b(9) })) {
      seen.push([...key]);
      const more = store.batch();
      more.put(b(1, 5), b(0));
      await more.write();
    }
    expect(seen).toEqual([[1], [2]]);
    expect(await collect(store.iterate({ start: b(0), end: b(9) }))).toEqual([[1], [1, 5], [2]]);
  });

  test('writing after close throws', async () => {
    const store = new MemoryStore();
    await store.close();
    const batch = store.batch();
    batch.put(b(1), b(1));
    await expect(batch.write()).rejects.toThrow(/closed/);
  });
});
