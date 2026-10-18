import { describe, expect, test } from 'vitest';
import { MemoryStore } from '@mindlog/storage';
import { headerKey } from '@mindlog/kv';
import {
  commitRecordKey,
  encodeLock,
  lockKey,
  readLock,
  rollbackRecordKey,
} from '../src/lock-store.js';
import { txnRangeHooks } from '@mindlog/txn';
import { b } from './support/txn-node.js';

describe('txn range hooks', () => {
  test('locks and records at or after the split key move to the new range; the rest stay', async () => {
    const store = new MemoryStore();
    const seed = store.batch();
    for (const name of ['apple', 'zebra']) {
      seed.put(
        lockKey(1n, 'default', b(name)),
        encodeLock({
          startTs: 5n,
          primary: b(name),
          ttlMs: 1000n,
          lockedAtMs: 1n,
          argv: [b('SET')],
        }),
      );
      seed.put(commitRecordKey(1n, 'default', b(name), 5n), new Uint8Array(8));
      seed.put(rollbackRecordKey(1n, 'default', b(name), 6n), new Uint8Array());
    }
    await seed.write();
    const batch = store.batch();
    await txnRangeHooks.split({ reader: store, batch }, 1n, 2n, headerKey('default', b('m')));
    await batch.write();
    expect(await readLock(store, 1n, 'default', b('apple'))).toBeDefined();
    expect(await readLock(store, 1n, 'default', b('zebra'))).toBeUndefined();
    expect(await readLock(store, 2n, 'default', b('zebra'))).toBeDefined();
    expect(await store.get(commitRecordKey(2n, 'default', b('zebra'), 5n))).toBeDefined();
    expect(await store.get(rollbackRecordKey(2n, 'default', b('zebra'), 6n))).toBeDefined();
    expect(await store.get(commitRecordKey(1n, 'default', b('zebra'), 5n))).toBeUndefined();
    // Merging brings everything back.
    const merge = store.batch();
    await txnRangeHooks.merge({ reader: store, batch: merge }, 1n, 2n);
    await merge.write();
    expect(await readLock(store, 1n, 'default', b('zebra'))).toBeDefined();
    expect(await store.get(commitRecordKey(1n, 'default', b('zebra'), 5n))).toBeDefined();
    expect(await store.get(rollbackRecordKey(1n, 'default', b('zebra'), 6n))).toBeDefined();
  });
});
