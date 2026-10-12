import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { encodeKey, keyPrefix } from '@mindlog/core';
import { MemoryStore, MvccReader, MvccTxn } from '@mindlog/storage';

const utf8 = new TextEncoder();
const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);
const key = (name: string) => {
  const r = encodeKey({ tenant: 't', family: 'k', tuple: ['h', name] });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const prefix = (() => {
  const r = keyPrefix('t', 'k', ['h']);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

async function commit(store: MemoryStore, index: bigint, apply: (txn: MvccTxn) => void) {
  const txn = new MvccTxn(store, index);
  apply(txn);
  const batch = store.batch();
  txn.writeTo(batch);
  await batch.write();
}

describe('MvccTxn', () => {
  test('reads its own pending writes and deletes before committed state', async () => {
    const store = new MemoryStore();
    await commit(store, 1n, (t) => {
      t.put(key('a'), utf8.encode('1'));
      t.put(key('b'), utf8.encode('1'));
    });
    const txn = new MvccTxn(store, 2n);
    txn.put(key('a'), utf8.encode('2'));
    txn.delete(key('b'));
    expect(text(await txn.get(key('a')))).toBe('2');
    expect(await txn.get(key('b'))).toBeUndefined();
    expect(txn.size).toBe(2);
    expect(text(await new MvccReader(store).get(key('a')))).toBe('1');
  });

  test('scans merge committed and pending entries in order, with limits and cursors', async () => {
    const store = new MemoryStore();
    await commit(store, 1n, (t) => {
      for (const n of ['a', 'c', 'e']) t.put(key(n), utf8.encode(`old-${n}`));
    });
    const txn = new MvccTxn(store, 2n);
    txn.put(key('b'), utf8.encode('new-b'));
    txn.put(key('c'), utf8.encode('new-c'));
    txn.delete(key('e'));
    txn.put(key('f'), utf8.encode('new-f'));
    const scan = async (options = {}) => {
      const out: string[] = [];
      for await (const e of txn.scan(prefix, options)) out.push(text(e.value) ?? '');
      return out.join(',');
    };
    expect(await scan()).toBe('old-a,new-b,new-c,new-f');
    expect(await scan({ reverse: true })).toBe('new-f,new-c,new-b,old-a');
    expect(await scan({ limit: 2 })).toBe('old-a,new-b');
    expect(await scan({ after: key('b') })).toBe('new-c,new-f');
    expect(await scan({ before: key('c') })).toBe('old-a,new-b');
    expect(await scan({ from: key('c') })).toBe('new-c,new-f');
  });

  test('after commit, the store matches a model of all transactions', async () => {
    const change = fc.tuple(
      fc.constantFrom('a', 'b', 'c', 'd'),
      fc.option(fc.string({ maxLength: 2 })),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(change, { maxLength: 4 }), { maxLength: 6 }),
        async (txns) => {
          const store = new MemoryStore();
          const model = new Map<string, string>();
          for (const [i, changes] of txns.entries()) {
            const txn = new MvccTxn(store, BigInt(i + 1));
            for (const [name, value] of changes) {
              if (value === null) {
                txn.delete(key(name));
                model.delete(name);
              } else {
                txn.put(key(name), utf8.encode(value));
                model.set(name, value);
              }
            }
            const merged: string[] = [];
            for await (const e of txn.scan(prefix)) merged.push(text(e.value) ?? '');
            expect(merged).toEqual([...model.keys()].sort().map((n) => model.get(n)));
            const batch = store.batch();
            txn.writeTo(batch);
            await batch.write();
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
