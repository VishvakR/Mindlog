import { describe, expect, test } from 'vitest';
import type { KvStore, WriteBatch } from '@mindlog/storage';
import { GroupCommitStore, MemoryStore } from '@mindlog/storage';
import { b, collect, describeKvStoreContract } from './contracts/kv-store-contract.js';

describeKvStoreContract('GroupCommitStore', () =>
  Promise.resolve(new GroupCommitStore(new MemoryStore())),
);

/** Counts the batches that reach the underlying store, and how many were synced. */
function counting(inner: KvStore) {
  const writes: { ops: number; sync: boolean }[] = [];
  const store: KvStore = {
    get: (k) => inner.get(k),
    iterate: (r, o) => inner.iterate(r, o),
    snapshot: () => inner.snapshot(),
    close: () => inner.close(),
    batch(): WriteBatch {
      const real = inner.batch();
      return {
        put: (k, v) => {
          real.put(k, v);
        },
        del: (k) => {
          real.del(k);
        },
        get length() {
          return real.length;
        },
        write: async (options) => {
          writes.push({ ops: real.length, sync: options?.sync ?? false });
          await real.write(options);
        },
      };
    },
  };
  return { store, writes };
}

describe('GroupCommitStore', () => {
  test('batches written in the same turn reach the store as one synced write', async () => {
    const { store, writes } = counting(new MemoryStore());
    const group = new GroupCommitStore(store);
    const one = group.batch();
    one.put(b(1), b(1));
    const two = group.batch();
    two.put(b(2), b(2));
    two.del(b(1));
    const three = group.batch();
    three.put(b(3), b(3));
    await Promise.all([one.write({ sync: true }), two.write(), three.write()]);
    expect(writes).toEqual([{ ops: 4, sync: true }]);
    expect(await collect(group.iterate({ start: b(0), end: b(9) }))).toEqual([[2], [3]]);
  });

  test('a write in a later turn is a new group', async () => {
    const { store, writes } = counting(new MemoryStore());
    const group = new GroupCommitStore(store);
    const first = group.batch();
    first.put(b(1), b(1));
    await first.write({ sync: true });
    const second = group.batch();
    second.put(b(2), b(2));
    await second.write();
    expect(writes).toEqual([
      { ops: 1, sync: true },
      { ops: 1, sync: false },
    ]);
  });

  test('a failed group write rejects every batch in it', async () => {
    const inner = new MemoryStore();
    const group = new GroupCommitStore(inner);
    await inner.close();
    const one = group.batch();
    one.put(b(1), b(1));
    const two = group.batch();
    two.put(b(2), b(2));
    const results = await Promise.allSettled([one.write(), two.write()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  });
});
