import { describe, expect, test } from 'vitest';
import type { Entry, KvReader, KvStore } from '@mindlog/storage';

export const b = (...bytes: number[]) => Uint8Array.from(bytes);
const range = (start: number[], end: number[]) => ({ start: b(...start), end: b(...end) });

export async function collect(iterable: AsyncIterable<Entry>): Promise<number[][]> {
  const out: number[][] = [];
  for await (const [key] of iterable) out.push([...key]);
  return out;
}

async function put(store: KvStore, ...entries: [number[], number[]][]): Promise<void> {
  const batch = store.batch();
  for (const [k, v] of entries) batch.put(b(...k), b(...v));
  await batch.write();
}

async function value(reader: KvReader, key: number[]): Promise<number[] | undefined> {
  const found = await reader.get(b(...key));
  return found ? [...found] : undefined;
}

/** Behaviour every KvStore implementation must have. */
export function describeKvStoreContract(name: string, open: () => Promise<KvStore>): void {
  describe(`KvStore contract: ${name}`, () => {
    test('get returns stored values and undefined for missing keys', async () => {
      const store = await open();
      await put(store, [[1], [10]], [[2], [20]]);
      expect(await value(store, [1])).toEqual([10]);
      expect(await value(store, [3])).toBeUndefined();
      await store.close();
    });

    test('iterate yields keys in unsigned byte order within [start, end)', async () => {
      const store = await open();
      await put(
        store,
        [[0xff], [1]],
        [[0x01, 0x00], [1]],
        [[0x01], [1]],
        [[0x80], [1]],
        [[0x02], [1]],
      );
      expect(await collect(store.iterate(range([0x01], [0xff])))).toEqual([
        [0x01],
        [0x01, 0x00],
        [0x02],
        [0x80],
      ]);
      await store.close();
    });

    test('iterate supports reverse order and limits', async () => {
      const store = await open();
      await put(store, [[1], [1]], [[2], [2]], [[3], [3]], [[4], [4]]);
      expect(await collect(store.iterate(range([1], [4]), { reverse: true }))).toEqual([
        [3],
        [2],
        [1],
      ]);
      expect(await collect(store.iterate(range([1], [9]), { limit: 2 }))).toEqual([[1], [2]]);
      expect(await collect(store.iterate(range([1], [9]), { reverse: true, limit: 1 }))).toEqual([
        [4],
      ]);
      await store.close();
    });

    test('a batch applies puts and deletes atomically, last write wins', async () => {
      const store = await open();
      await put(store, [[1], [1]], [[2], [2]]);
      const batch = store.batch();
      batch.put(b(3), b(3));
      batch.del(b(1));
      batch.put(b(2), b(22));
      batch.put(b(2), b(23));
      expect(batch.length).toBe(4);
      await batch.write({ sync: true });
      expect(await collect(store.iterate(range([0], [9])))).toEqual([[2], [3]]);
      expect(await value(store, [2])).toEqual([23]);
      await store.close();
    });

    test('a snapshot does not see later writes', async () => {
      const store = await open();
      await put(store, [[1], [1]]);
      const snapshot = await store.snapshot();
      await put(store, [[1], [9]], [[2], [2]]);
      expect(await value(snapshot, [1])).toEqual([1]);
      expect(await collect(snapshot.iterate(range([0], [9])))).toEqual([[1]]);
      expect(await value(store, [1])).toEqual([9]);
      await snapshot.release();
      await store.close();
    });

    test('values are copies: mutating a returned buffer changes nothing', async () => {
      const store = await open();
      const input = b(5);
      const batch = store.batch();
      batch.put(b(1), input);
      await batch.write();
      input[0] = 6;
      const read = await store.get(b(1));
      if (read) read[0] = 7;
      expect(await value(store, [1])).toEqual([5]);
      await store.close();
    });
  });
}
