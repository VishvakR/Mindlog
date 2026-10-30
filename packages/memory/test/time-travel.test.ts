import { describe, expect, test } from 'vitest';
import type { AsOf, RecallInput, RememberInput } from '@mindlog/memory';
import { MemoryReads } from '@mindlog/memory';
import { START, TENANT, ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string, extra: Partial<RememberInput> = {}) {
  const r = await n.engine.remember(
    n.range,
    { scope: scope(), content, kind: 'semantic', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  n.clock.advance(1000n);
  return { id: r.value.ids[0] as string, index: r.value.memories[0]?.createdAtMs ?? 0 };
}

async function ids(n: Node, query: string, extra: Partial<RecallInput> = {}) {
  const r = await n.engine.recall(
    n.range,
    { scope: scope(), query, recipe: 'hybrid', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.value.items.map((i) => i.memory.id);
}

/** The log index of a memory's commit. */
async function logIndex(n: Node, id: string): Promise<bigint> {
  const r = await new MemoryReads(n.range.reader, TENANT, 'u1').record(id);
  return r?.logIndex ?? 0n;
}

describe('ASOF (PLAN 13.3)', () => {
  test('recall, get and list read the scope as of a log index', async () => {
    const n = await memoryNode();
    const coffee = await remember(n, 'I drink black coffee every morning.');
    const at = await logIndex(n, coffee.id);
    const forgot = await n.engine.forget(n.range, { scope: scope(), ids: [coffee.id] }, ctx);
    expect(forgot.ok).toBe(true);
    const tea = await remember(n, 'I switched to green tea in the morning.');

    expect(await ids(n, 'morning coffee tea')).toEqual([tea.id]);
    const asOf: AsOf = { index: at };
    expect(await ids(n, 'morning coffee tea', { asOf })).toEqual([coffee.id]);

    const got = await n.engine.get(n.range, scope(), coffee.id, { asOf });
    expect(got.ok && got.value?.expiredAtMs).toBeUndefined();
    const listed = await n.engine.list(n.range, scope(), { limit: 10, asOf });
    expect(listed.ok && listed.value.memories.map((m) => m.id)).toEqual([coffee.id]);
  });

  test('a time reads every commit at or before it, an index before any memory reads nothing', async () => {
    const n = await memoryNode();
    const a = await remember(n, 'Ana lives in Lisbon.');
    const b = await remember(n, 'Ana moved to Porto in spring.');
    expect(await ids(n, 'Ana', { asOf: { timeMs: a.index } })).toEqual([a.id]);
    expect((await ids(n, 'Ana', { asOf: { timeMs: b.index } })).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(await ids(n, 'Ana', { asOf: { index: 0n } })).toEqual([]);
  });
});

describe('VALID_AT', () => {
  test('recall returns facts true now unless asked about another time', async () => {
    const n = await memoryNode();
    const day = 86_400_000;
    const now = Number(START);
    const past = await remember(n, 'The user is vegetarian.', {
      validFromMs: now - 300 * day,
      validToMs: now - 30 * day,
    });
    const current = await remember(n, 'The user eats fish again.', { validFromMs: now - 30 * day });
    const future = await remember(n, 'The user plans a vegan diet.', {
      validFromMs: now + 30 * day,
    });

    expect(await ids(n, 'user vegetarian fish vegan diet')).toEqual([current.id]);
    expect(await ids(n, 'user vegetarian fish vegan diet', { validAtMs: now - 100 * day })).toEqual(
      [past.id],
    );
    expect(await ids(n, 'user vegan diet', { validAtMs: now + 60 * day })).toContain(future.id);

    const got = await n.engine.get(n.range, scope(), past.id);
    expect(got.ok && got.value?.validToMs).toBe(now - 30 * day);
  });
});
