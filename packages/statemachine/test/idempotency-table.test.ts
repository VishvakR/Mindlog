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
    table.record(batch, id, ok);
    await batch.write();
    expect(await table.lookup(id)).toEqual(ok);
  });

  test('ignores commands without a request id', async () => {
    const store = new MemoryStore();
    const table = new IdempotencyTable(store);
    const batch = store.batch();
    table.record(batch, new Uint8Array(), ok);
    expect(batch.length).toBe(0);
    expect(await table.lookup(new Uint8Array())).toBeUndefined();
  });

  test('node keys live under the $node tenant and never collide', () => {
    expect(compareBytes(appliedIndexKey(1n), idempotencyKey(Uint8Array.of(1)))).not.toBe(0);
    expect(new TextDecoder().decode(appliedIndexKey(1n))).toContain('$node');
  });
});
