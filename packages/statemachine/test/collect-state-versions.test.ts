import { describe, expect, test } from 'vitest';
import { NODE_TENANT, encodeKey } from '@mindlog/core';
import { MemoryStore, MvccReader, MvccWriter } from '@mindlog/storage';
import { collectStateVersions, wholeKeyspace } from '@mindlog/statemachine';

const utf8 = new TextEncoder();
const key = (tenant: string, name: string) => {
  const r = encodeKey({ tenant, family: 'k', tuple: [name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

async function versions(store: MemoryStore, tenant: string, name: string, count: number) {
  for (let i = 1; i <= count; i++) {
    const batch = store.batch();
    new MvccWriter(batch, BigInt(i)).put(key(tenant, name), utf8.encode(`v${i}`));
    await batch.write();
  }
}

async function rawCount(store: MemoryStore) {
  let n = 0;
  for await (const _ of store.iterate({ start: new Uint8Array(), end: Uint8Array.of(0xff) })) n++;
  return n;
}

describe('collectStateVersions', () => {
  test('sweeps every tenant in bounded passes and leaves raw $node keys alone', async () => {
    const store = new MemoryStore();
    for (const tenant of ['acme', 'beta', 'zeta']) await versions(store, tenant, 'k', 4);
    const nodeBatch = store.batch();
    // A raw key that happens to look versioned must never be touched.
    nodeBatch.put(
      new Uint8Array([...key(NODE_TENANT, 'raw'), 0x40, 1, 2, 3, 4, 5, 6, 7, 8]),
      Uint8Array.of(0x0a),
    );
    await nodeBatch.write();
    expect(await rawCount(store)).toBe(13);

    let passes = 0;
    let total = 0;
    for (;;) {
      const batch = store.batch();
      const result = await collectStateVersions({ reader: store, batch }, wholeKeyspace(1n), 4n, 2);
      await batch.write();
      total += result.removed;
      passes++;
      if (result.completed) break;
    }
    expect(total).toBe(6);
    expect(passes).toBeGreaterThan(2);
    expect(await rawCount(store)).toBe(7);
    for (const tenant of ['acme', 'beta', 'zeta']) {
      expect(await new MvccReader(store).get(key(tenant, 'k'))).toEqual(utf8.encode('v4'));
    }
  });
});
