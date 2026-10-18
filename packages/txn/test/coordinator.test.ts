import { describe, expect, test } from 'vitest';
import { b, twoRanges } from './support/two-ranges.js';

describe('TxnCoordinator across two ranges', () => {
  test('a transaction commits writes on both ranges together', async () => {
    const t = await twoRanges();
    const done = await t.coordinator.run('default', (txn) => {
      txn.write([b('SET'), b('apple'), b('1')]);
      txn.write([b('SET'), b('zebra'), b('2')]);
      return Promise.resolve({ ok: true as const, value: undefined });
    });
    expect(done.ok).toBe(true);
    expect(await t.read('apple')).toBe('1');
    expect(await t.read('zebra')).toBe('2');
  });

  test('a read-modify-write transfer moves money between ranges and keeps the total', async () => {
    const t = await twoRanges();
    await t.coordinator.run('default', (txn) => {
      txn.write([b('SET'), b('apple'), b('100')]);
      txn.write([b('SET'), b('zebra'), b('100')]);
      return Promise.resolve({ ok: true as const, value: undefined });
    });
    const move = async (from: string, to: string, amount: number) =>
      t.coordinator.run('default', async (txn) => {
        const a = await txn.get([b('GET'), b(from)]);
        if (!a.ok) return a;
        txn.write([b('DECRBY'), b(from), b(String(amount))]);
        txn.write([b('INCRBY'), b(to), b(String(amount))]);
        return { ok: true as const, value: undefined };
      });
    for (let i = 0; i < 10; i++) expect((await move('apple', 'zebra', 7)).ok).toBe(true);
    expect((await move('zebra', 'apple', 3)).ok).toBe(true);
    expect(Number(await t.read('apple')) + Number(await t.read('zebra'))).toBe(200);
    expect(await t.read('apple')).toBe('33');
  });

  test('a transaction that stops after prewrite is rolled back by whoever meets its lock', async () => {
    const t = await twoRanges();
    const stalled = await t.coordinator.run('default', () =>
      Promise.resolve({ ok: true as const, value: 1 }),
    );
    expect(stalled.ok).toBe(true);
    // Lock a key as if a coordinator died after its prewrite.
    const start = await t.cluster.tso();
    if (!start.ok) throw new Error('tso');
    await t.cluster.run('default', b('apple'), {
      kind: 'prewrite',
      body: {
        $typeName: 'mindlog.v1.TxnPrewrite',
        startTs: start.value,
        primary: b('apple'),
        ttlMs: 100n,
        writes: [{ $typeName: 'mindlog.v1.KvWrite', argv: [b('SET'), b('apple'), b('lost')] }],
      },
    });
    // The lock outlives its TTL; a later transaction clears it and proceeds.
    const next = await t.coordinator.run('default', (txn) => {
      txn.write([b('SET'), b('apple'), b('fresh')]);
      return Promise.resolve({ ok: true as const, value: undefined });
    });
    expect(next.ok).toBe(true);
    expect(await t.read('apple')).toBe('fresh');
  });

  test('a conflicting write is retried against a fresh snapshot', async () => {
    const t = await twoRanges();
    let runs = 0;
    const result = await t.coordinator.run('default', async (txn) => {
      runs++;
      const seen = await txn.get([b('GET'), b('apple')]);
      if (!seen.ok) return seen;
      // A competing transaction commits between this one's start and its prewrite.
      if (runs === 1)
        await t.coordinator.run('default', (other) => {
          other.write([b('SET'), b('apple'), b('other')]);
          return Promise.resolve({ ok: true as const, value: undefined });
        });
      txn.write([b('SET'), b('apple'), b('mine')]);
      return { ok: true as const, value: undefined };
    });
    expect(result.ok).toBe(true);
    expect(runs).toBe(2);
    expect(await t.read('apple')).toBe('mine');
  });
});
