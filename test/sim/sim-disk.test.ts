import { expect, test } from 'vitest';
import { SimDisk } from './sim-disk.js';

const b = (s: string): Uint8Array => new TextEncoder().encode(s);

test('an unsynced write made while a sync is in flight is not lost from the unsynced list', async () => {
  const disk = new SimDisk();
  const store = disk.open();
  const synced = store.batch();
  synced.put(b('a'), b('1'));
  const later = store.batch();
  later.put(b('b'), b('2'));
  await Promise.all([synced.write({ sync: true }), later.write()]);
  expect(disk.unsyncedBatches).toBe(1);
  // A power loss that keeps the one unsynced batch keeps its data.
  await disk.crash(true, 1);
  const after = disk.open();
  expect(await after.get(b('a'))).toEqual(b('1'));
  expect(await after.get(b('b'))).toEqual(b('2'));
});
