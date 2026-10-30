import { err, mindlogError } from '@mindlog/core';
import { describe, expect, test } from 'vitest';
import type { ConflictConfig, MemoryConfig, RememberInput } from '@mindlog/memory';
import { applyPolicy, disjoint, supersedes, verdict } from '@mindlog/memory';
import { START, ctx, memoryNode, scope } from './support/memory-node.js';

const config: ConflictConfig = {
  conflictThreshold: 0.8,
  duplicateThreshold: 0.9,
  conflictPolicy: 'quarantine_new',
  conflictCandidates: 5,
  conflictMinSimilarity: 0.5,
};
const DAY = 86_400_000;

describe('conflict rules (ADR-0015)', () => {
  test('either NLI direction over θ_c is a contradiction; strong entailment is a duplicate', () => {
    const c = { label: 'contradiction', score: 0.85 } as const;
    const n = { label: 'neutral', score: 0.9 } as const;
    expect(verdict(n, c, config)).toEqual({ kind: 'contradiction', scoreAB: 0, scoreBA: 0.85 });
    expect(verdict({ label: 'contradiction', score: 0.7 }, n, config).kind).toBe('independent');
    expect(verdict({ label: 'entailment', score: 0.95 }, n, config)).toEqual({
      kind: 'duplicate',
      score: 0.95,
    });
    expect(verdict({ label: 'entailment', score: 0.85 }, n, config).kind).toBe('independent');
    expect(verdict(undefined, undefined, config).kind).toBe('independent');
  });

  test("Graphiti's temporal rule: known, non-overlapping windows are history", () => {
    const old = { validFrom: 100, validTo: 200 };
    expect(disjoint(old, { validFrom: 200, validTo: 0 })).toBe(true);
    expect(disjoint({ validFrom: 300, validTo: 0 }, old)).toBe(true);
    expect(disjoint(old, { validFrom: 150, validTo: 0 })).toBe(false);
    expect(disjoint(old, { validFrom: 0, validTo: 0 })).toBe(false);
  });

  test('a later fact supersedes an open-ended older one', () => {
    expect(supersedes({ validFrom: 100, validTo: 0 }, { validFrom: 150, validTo: 0 })).toBe(150);
    expect(
      supersedes({ validFrom: 100, validTo: 0 }, { validFrom: 50, validTo: 0 }),
    ).toBeUndefined();
    expect(
      supersedes({ validFrom: 0, validTo: 0 }, { validFrom: 150, validTo: 0 }),
    ).toBeUndefined();
    expect(
      supersedes({ validFrom: 100, validTo: 120 }, { validFrom: 150, validTo: 0 }),
    ).toBeUndefined();
  });

  test('policies', () => {
    expect(applyPolicy('quarantine_new', 'normal', 'normal')).toEqual({
      trust: 'quarantined',
      supersedeExisting: false,
      status: 'open',
    });
    expect(applyPolicy('newest_wins', 'normal', 'normal')).toEqual({
      trust: 'normal',
      supersedeExisting: true,
      status: 'resolved',
    });
    expect(applyPolicy('ask_human', 'normal', 'normal').trust).toBe('normal');
    expect(applyPolicy('prefer_verified', 'verified', 'normal').trust).toBe('quarantined');
    expect(applyPolicy('prefer_verified', 'normal', 'verified').supersedeExisting).toBe(true);
    expect(applyPolicy('prefer_verified', 'normal', 'normal').status).toBe('open');
  });
});

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string, extra: Partial<RememberInput> = {}) {
  const r = await n.engine.remember(
    n.range,
    { scope: scope(), content, kind: 'semantic', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  n.clock.advance(1000n);
  return r.value;
}

async function recalled(n: Node, query: string, includeQuarantined = false) {
  const r = await n.engine.recall(
    n.range,
    { scope: scope(), query, recipe: 'hybrid', includeQuarantined },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.value.items.map((i) => i.memory.id);
}

async function open(n: Node) {
  const r = await n.engine.conflicts(n.range, scope(), { limit: 10 });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.conflicts;
}

// FakeModels scores contradictions 0.9; these tests are about the mechanism, not the tuned threshold.
const node = (config: Partial<MemoryConfig> = {}) =>
  memoryNode({ config: { conflictThreshold: 0.8, ...config } });

describe('conflict detection before commit', () => {
  test('quarantines a contradicting fact and raises a conflict that a resolution settles', async () => {
    const n = await node();
    const a = (await remember(n, 'The user likes coffee.')).ids[0] as string;
    const added = await remember(n, 'The user does not like coffee.');
    const b = added.ids[0] as string;
    expect(added.memories[0]?.trust).toBe('quarantined');
    const [conflict] = await open(n);
    expect(conflict).toMatchObject({
      a: { id: a },
      b: { id: b },
      status: 'open',
      policy: 'quarantine_new',
    });
    expect(await recalled(n, 'user coffee')).toEqual([a]);
    expect(await recalled(n, 'user coffee', true)).toContain(b);

    const resolved = await n.engine.resolve(
      n.range,
      { scope: scope(), id: conflict?.id ?? '', keep: 'b' },
      ctx,
    );
    expect(resolved.ok && resolved.value.ids.sort()).toEqual([a, b].sort());
    expect(await recalled(n, 'user coffee')).toEqual([b]);
    expect(await open(n)).toEqual([]);
    const all = await n.engine.conflicts(n.range, scope(), { all: true, limit: 10 });
    expect(all.ok && all.value.conflicts[0]).toMatchObject({ status: 'resolved', keep: 'b' });
    const old = await n.engine.get(n.range, scope(), a);
    expect(old.ok && old.value?.validToMs).toBe(Number(START) + 2000);
    // History, not deletion.
    expect(old.ok && old.value?.expiredAtMs).toBeUndefined();

    const again = await n.engine.resolve(
      n.range,
      { scope: scope(), id: conflict?.id ?? '', keep: 'a' },
      ctx,
    );
    expect(!again.ok && again.error.code).toBe('CONFLICT');
  });

  test('keep both with a date records a change over time', async () => {
    const n = await node();
    const a = (await remember(n, 'The user is not vegetarian.')).ids[0] as string;
    const b = (await remember(n, 'The user is vegetarian.')).ids[0] as string;
    const [conflict] = await open(n);
    const at = Number(START) - 10 * DAY;
    const r = await n.engine.resolve(
      n.range,
      { scope: scope(), id: conflict?.id ?? '', keep: 'both', validFromMs: at },
      ctx,
    );
    expect(r.ok).toBe(true);
    const got = async (id: string) => {
      const m = await n.engine.get(n.range, scope(), id);
      return m.ok ? m.value : undefined;
    };
    expect(await got(a)).toMatchObject({ validToMs: at, trust: 'normal' });
    expect(await got(b)).toMatchObject({ validFromMs: at, trust: 'normal' });
  });

  test('newest_wins ends the old fact at once', async () => {
    const n = await node({ conflictPolicy: 'newest_wins' });
    const a = (await remember(n, 'The user likes coffee.')).ids[0] as string;
    const b = (await remember(n, 'The user does not like coffee.')).ids[0] as string;
    expect(await open(n)).toEqual([]);
    expect(await recalled(n, 'user coffee')).toEqual([b]);
    const all = await n.engine.conflicts(n.range, scope(), { all: true, limit: 10 });
    expect(all.ok && all.value.conflicts[0]).toMatchObject({ a: { id: a }, keep: 'b' });
  });

  test('a contradiction that starts later supersedes an open-ended fact instead of conflicting', async () => {
    const n = await node();
    const now = Number(START);
    const a = (await remember(n, 'The user likes coffee.', { validFromMs: now - 100 * DAY }))
      .ids[0] as string;
    const b = (await remember(n, 'The user does not like coffee.', { validFromMs: now - DAY }))
      .ids[0] as string;
    expect(await open(n)).toEqual([]);
    const old = await n.engine.get(n.range, scope(), a);
    expect(old.ok && old.value?.validToMs).toBe(now - DAY);
    expect(await recalled(n, 'user coffee')).toEqual([b]);
  });

  test('a restated fact is a duplicate: it supports the original and weighs less', async () => {
    const n = await node();
    const first = await remember(n, 'The user lives in Lisbon.');
    const second = await remember(n, 'The user lives in Lisbon.');
    const dup = second.memories[0];
    const support = dup?.links.find((l) => l.relation === 'supports');
    expect(support?.to).toBe(first.ids[0]);
    expect(support?.weight).toBeCloseTo(0.9);
    expect(dup?.importance).toBeLessThan(first.memories[0]?.importance ?? 0);
    expect(await open(n)).toEqual([]);
  });

  test('without the NLI model the fact is stored and the run is degraded', async () => {
    const n = await node();
    await remember(n, 'The user likes coffee.');
    n.models.classify = () => Promise.resolve(err(mindlogError('UNAVAILABLE', 'nli down')));
    const r = await remember(n, 'The user does not like coffee.');
    expect(r.degraded).toBe(true);
    expect(r.memories[0]?.trust).toBe('normal');
    expect(await open(n)).toEqual([]);
  });

  test('trust review releases quarantined content', async () => {
    const n = await node();
    const web = await remember(n, 'Coffee prices doubled this year.', {
      source: { type: 'web' },
    });
    const id = web.ids[0] as string;
    expect(await recalled(n, 'coffee prices')).toEqual([]);
    const r = await n.engine.setTrust(n.range, { scope: scope(), ids: [id], trust: 'normal' }, ctx);
    expect(r.ok && r.value.ids).toEqual([id]);
    expect(await recalled(n, 'coffee prices')).toEqual([id]);
  });
});
