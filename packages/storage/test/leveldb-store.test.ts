import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { KvStore } from '@mindlog/storage';
import { LevelDbStore } from '@mindlog/storage';
import { b, describeKvStoreContract } from './contracts/kv-store-contract.js';
import { tempDir } from './temp-dir.js';

async function openAt(path: string): Promise<KvStore> {
  const opened = await LevelDbStore.open(path);
  if (!opened.ok) throw new Error(opened.error.message);
  return opened.value;
}

describeKvStoreContract('LevelDbStore', () => openAt(join(tempDir(), 'db')));

describe('LevelDbStore', () => {
  test('synced writes survive close and reopen', async () => {
    const path = join(tempDir(), 'db');
    const store = await openAt(path);
    const batch = store.batch();
    batch.put(b(1), b(42));
    await batch.write({ sync: true });
    await store.close();
    const reopened = await openAt(path);
    expect(await reopened.get(b(1))).toEqual(b(42));
    await reopened.close();
  });

  test('a second open of the same directory reports UNAVAILABLE', async () => {
    const path = join(tempDir(), 'db');
    const first = await openAt(path);
    const second = await LevelDbStore.open(path);
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('UNAVAILABLE');
      expect(second.error.message).toMatch(/in use by another process/);
    }
    await first.close();
  });

  test('returns plain Uint8Arrays, not Buffers', async () => {
    const store = await openAt(join(tempDir(), 'db'));
    const batch = store.batch();
    batch.put(b(1), b(2));
    await batch.write();
    const value = await store.get(b(1));
    expect(Buffer.isBuffer(value)).toBe(false);
    for await (const [key, v] of store.iterate({ start: b(0), end: b(9) })) {
      expect(Buffer.isBuffer(key) || Buffer.isBuffer(v)).toBe(false);
    }
    await store.close();
  });
});
