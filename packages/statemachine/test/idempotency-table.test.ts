import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { CommandResultSchema } from '@mindlog/proto';
import { IdempotencyTable, appliedIndexKey, idempotencyKey } from '@mindlog/statemachine';
import { MemoryStore, compareBytes } from '@mindlog/storage';

const ok = create(CommandResultSchema, {
  outcome: { case: 'kv', value: { kind: { case: 'simple', value: 'OK' } } },
});

describe('IdempotencyTable', () => {
  test('returns the recorded result for a request id', async () => {
    const store = new MemoryStore();
    const table = new IdempotencyTable(store);
    const id = Uint8Array.of(1, 2, 3);
    expect(await table.lookup(id)).toBeUndefined();
    const batch = store.batch();
    table.record(batch, id, ok, 1n);
    await batch.write();
    expect(await table.lookup(id)).toEqual(ok);
  });

  test('ignores commands without a request id', async () => {
    const store = new MemoryStore();
    const table = new IdempotencyTable(store);
    const batch = store.batch();
    table.record(batch, new Uint8Array(), ok, 1n);
    expect(batch.length).toBe(0);
    expect(await table.lookup(new Uint8Array())).toBeUndefined();
  });

  test('collect drops records older than the threshold, oldest first', async () => {
    const store = new MemoryStore();
    const table = new IdempotencyTable(store);
    const batch = store.batch();
    for (let i = 1; i <= 5; i++) table.record(batch, Uint8Array.of(i), ok, BigInt(i));
    await batch.write();
    const gc = store.batch();
    expect(await IdempotencyTable.collect({ reader: store, batch: gc }, 4n, 2)).toBe(2);
    await gc.write();
    expect(await table.lookup(Uint8Array.of(1))).toBeUndefined();
    expect(await table.lookup(Uint8Array.of(2))).toBeUndefined();
    expect(await table.lookup(Uint8Array.of(3))).toEqual(ok);
    const rest = store.batch();
    expect(await IdempotencyTable.collect({ reader: store, batch: rest }, 4n, 10)).toBe(1);
    await rest.write();
    expect(await table.lookup(Uint8Array.of(4))).toEqual(ok);
  });

  test('node keys live under the $node tenant and never collide', () => {
    expect(compareBytes(appliedIndexKey(1n), idempotencyKey(Uint8Array.of(1)))).not.toBe(0);
    expect(new TextDecoder().decode(appliedIndexKey(1n))).toContain('$node');
  });
});
