import { describe, expect, test } from 'vitest';
import { KvType } from '@mindlog/proto';
import { Keyspace, deadGenerationPrefix, expiryIndexPrefix } from '@mindlog/kv';
import { MemoryStore, MvccReader, MvccTxn } from '@mindlog/storage';

const name = new TextEncoder().encode('cart');

async function commit(
  store: MemoryStore,
  index: bigint,
  nowMs: bigint,
  run: (ks: Keyspace) => Promise<void>,
) {
  const txn = new MvccTxn(store, index);
  await run(new Keyspace({ tenant: 't', nowMs, view: txn, writer: txn, index }));
  const batch = store.batch();
  txn.writeTo(batch);
  await batch.write();
}

async function count(store: MemoryStore, prefix: Uint8Array): Promise<number> {
  let n = 0;
  for await (const _ of new MvccReader(store).scan(prefix)) n++;
  return n;
}

describe('Keyspace', () => {
  test('a new key gets the creating index as generation and version', async () => {
    const store = new MemoryStore();
    await commit(store, 5n, 0n, (ks) => {
      ks.write(name, ks.fresh(KvType.HASH));
      return Promise.resolve();
    });
    const header = await new Keyspace({
      tenant: 't',
      nowMs: 0n,
      view: new MvccReader(store),
      index: 0n,
    }).header(name);
    expect([header?.type, header?.generation, header?.version]).toEqual([KvType.HASH, 5n, 5n]);
  });

  test('expiry is lazy for reads and deletes the key inside apply', async () => {
    const store = new MemoryStore();
    await commit(store, 1n, 0n, (ks) => {
      const header = ks.fresh(KvType.SET);
      ks.setExpiry(name, header, 100n);
      ks.write(name, header);
      return Promise.resolve();
    });
    expect(await count(store, expiryIndexPrefix())).toBe(1);
    const reader = (nowMs: bigint) =>
      new Keyspace({ tenant: 't', nowMs, view: new MvccReader(store), index: 0n });
    expect(await reader(100n).header(name)).toBeDefined();
    expect(await reader(101n).header(name)).toBeUndefined();

    await commit(store, 2n, 101n, async (ks) => {
      expect(await ks.header(name)).toBeUndefined();
    });
    expect(await count(store, expiryIndexPrefix())).toBe(0);
    expect(await count(store, deadGenerationPrefix())).toBe(1);
    expect(await reader(0n).header(name)).toBeUndefined();
  });

  test('deleting a string records no dead generation', async () => {
    const store = new MemoryStore();
    await commit(store, 1n, 0n, (ks) => {
      ks.write(name, ks.fresh(KvType.STRING));
      return Promise.resolve();
    });
    await commit(store, 2n, 0n, async (ks) => {
      const header = await ks.header(name);
      if (header) ks.delete(name, header);
    });
    expect(await count(store, deadGenerationPrefix())).toBe(0);
  });

  test('writing outside apply is a programmer error', () => {
    const ks = new Keyspace({
      tenant: 't',
      nowMs: 0n,
      view: new MvccReader(new MemoryStore()),
      index: 0n,
    });
    expect(() => {
      ks.write(name, ks.fresh(KvType.STRING));
    }).toThrow(/outside apply/);
  });
});
