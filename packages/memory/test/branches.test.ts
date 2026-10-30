import { describe, expect, test } from 'vitest';
import type { MemoryConfig, MergePolicy, RecallInput, RememberInput } from '@mindlog/memory';
import { MemoryReads } from '@mindlog/memory';
import { TENANT, ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string, extra: Partial<RememberInput> = {}) {
  const r = await n.engine.remember(
    n.range,
    { scope: scope(), content, kind: 'semantic', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  n.clock.advance(1000n);
  return r.value.ids[0] as string;
}

async function ids(n: Node, query: string, extra: Partial<RecallInput> = {}) {
  const r = await n.engine.recall(
    n.range,
    { scope: scope(), query, recipe: 'hybrid', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.items.map((i) => i.memory.id).sort();
}

async function branch(n: Node, name = 'plan') {
  const r = await n.engine.createBranch(n.range, scope(), name, ctx);
  if (!r.ok) throw new Error(r.error.message);
  n.clock.advance(1000n);
}

async function merge(n: Node, policy: MergePolicy, name = 'plan') {
  const r = await n.engine.mergeBranch(n.range, { scope: scope(), name, policy }, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

const node = (config: Partial<MemoryConfig> = {}) => memoryNode({ config });

describe('branch isolation (ADR-0013)', () => {
  test('a branch sees main as of its fork plus its own writes; main sees neither', async () => {
    const n = await node();
    const before = await remember(n, 'Ana works at Acme in Lisbon.');
    await branch(n);
    const after = await remember(n, 'Ana bought a bike in Lisbon.');
    const planned = await remember(n, 'Ana will move to Porto next year.', { branch: 'plan' });

    expect(await ids(n, 'Ana Lisbon Porto')).toEqual([before, after].sort());
    expect(await ids(n, 'Ana Lisbon Porto', { branch: 'plan' })).toEqual([before, planned].sort());
    const got = await n.engine.get(n.range, scope(), planned);
    expect(got.ok && got.value).toBeUndefined();
    const listed = await n.engine.list(n.range, scope(), { limit: 10, branch: 'plan' });
    expect(listed.ok && listed.value.memories.map((m) => m.id)).toEqual([before, planned].sort());
  });

  test('forgetting a main memory on a branch hides it only there', async () => {
    const n = await node();
    const kept = await remember(n, 'Ana works at Acme.');
    await branch(n);
    const r = await n.engine.forget(n.range, { scope: scope(), ids: [kept], branch: 'plan' }, ctx);
    expect(r.ok && r.value.ids).toEqual([kept]);
    expect(await ids(n, 'Ana Acme', { branch: 'plan' })).toEqual([]);
    expect(await ids(n, 'Ana Acme')).toEqual([kept]);
    const diff = await n.engine.diffBranch(n.range, scope(), 'plan');
    expect(diff.ok && diff.value.forgotten.map((m) => m.id)).toEqual([kept]);
  });

  test('names are checked, branches are listed, a dropped branch is gone with its memories', async () => {
    const n = await node();
    const bad = await n.engine.createBranch(n.range, scope(), 'main', ctx);
    expect(!bad.ok && bad.error.code).toBe('INVALID_ARGUMENT');
    await branch(n);
    const dup = await n.engine.createBranch(n.range, scope(), 'plan', ctx);
    expect(!dup.ok && dup.error.code).toBe('ALREADY_EXISTS');
    await remember(n, 'Ana will move to Porto.', { branch: 'plan' });
    const dropped = await n.engine.dropBranch(n.range, scope(), 'plan', ctx);
    expect(dropped.ok).toBe(true);
    const listed = await n.engine.branches(n.range, scope());
    expect(listed.ok && listed.value.map((b) => [b.name, b.status, b.writes])).toEqual([
      ['plan', 'dropped', 1],
    ]);
    const r = await n.engine.recall(
      n.range,
      { scope: scope(), query: 'Porto', branch: 'plan' },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe('NOT_FOUND');
    let left = 0;
    for await (const _ of new MemoryReads(n.range.reader, TENANT, {
      user: 'u1',
      branch: 'plan',
    }).records())
      left++;
    expect(left).toBe(0);
  });

  test('a branch holds at most branchMaxWrites memories', async () => {
    const n = await node({ branchMaxWrites: 1 });
    await branch(n);
    await remember(n, 'Ana will move to Porto.', { branch: 'plan' });
    const r = await n.engine.remember(
      n.range,
      { scope: scope(), content: 'Ana will sell her bike.', kind: 'semantic', branch: 'plan' },
      ctx,
    );
    expect(!r.ok && r.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('merging', () => {
  test('a clean merge brings the branch into main and closes it', async () => {
    const n = await node();
    const kept = await remember(n, 'Ana works at Acme.');
    const old = await remember(n, 'Ana lives in Lisbon.');
    await branch(n);
    const planned = await remember(n, 'Ana will move to Porto next year.', { branch: 'plan' });
    await n.engine.forget(n.range, { scope: scope(), ids: [old], branch: 'plan' }, ctx);
    const result = await merge(n, 'raise');
    expect(result).toEqual({ merged: true, added: [planned], rejected: [], conflicts: [] });
    expect(await ids(n, 'Ana Acme Lisbon Porto')).toEqual([kept, planned].sort());
    const listed = await n.engine.branches(n.range, scope());
    expect(listed.ok && listed.value[0]?.status).toBe('merged');
  });

  test.each<[MergePolicy, (n: Node, a: string, b: string) => Promise<void>]>([
    [
      'raise',
      async (n, a, b) => {
        expect(await ids(n, 'user coffee')).toEqual([a]);
        const c = await n.engine.conflicts(n.range, scope(), { limit: 5 });
        expect(c.ok && c.value.conflicts).toMatchObject([
          { a: { id: a }, b: { id: b, trust: 'quarantined' }, origin: 'merge:plan' },
        ]);
      },
    ],
    [
      'prefer_branch',
      async (n, a, b) => {
        expect(await ids(n, 'user coffee')).toEqual([b]);
        const old = await n.engine.get(n.range, scope(), a);
        expect(old.ok && old.value?.validToMs).toBeDefined();
      },
    ],
    [
      'prefer_main',
      async (n, a) => {
        expect(await ids(n, 'user coffee', { includeQuarantined: true })).toEqual([a]);
      },
    ],
    [
      'abort',
      async (n, a) => {
        expect(await ids(n, 'user coffee')).toEqual([a]);
        const listed = await n.engine.branches(n.range, scope());
        expect(listed.ok && listed.value[0]?.status).toBe('open');
      },
    ],
  ])('a contradiction under %s', async (policy, check) => {
    const n = await node();
    const a = await remember(n, 'The user likes coffee.');
    await branch(n);
    const b = await remember(n, 'The user does not like coffee.', { branch: 'plan' });
    const result = await merge(n, policy);
    expect(result.merged).toBe(policy !== 'abort');
    expect(result.conflicts.map((c) => [c.a, c.b])).toEqual(
      policy === 'prefer_main' ? [] : [[a, b]],
    );
    await check(n, a, b);
  });

  test('a merge planned against an older main is refused', async () => {
    const n = await node();
    await branch(n);
    await remember(n, 'Ana will move to Porto.', { branch: 'plan' });
    const command = n.stamper.stamp(TENANT, 'agent:test', {
      case: 'branchMerge',
      value: { user: 'u1', name: 'plan', policy: 'raise', mainGeneration: 99n },
    });
    const r = await n.propose(command);
    expect(r.outcome.case === 'error' && r.outcome.value.code).toBe('CONFLICT');
  });

  test('entity edges add up: main weight plus the branch’s', async () => {
    const n = await node();
    await remember(n, 'Ana and Bruno met at Acme.');
    await branch(n);
    await remember(n, 'Ana and Bruno met at Acme again.', { branch: 'plan' });
    const reads = new MemoryReads(n.range.reader, TENANT, 'u1');
    const edges = async () => {
      const out: Record<string, number> = {};
      for await (const e of reads.edges()) out[`${e.src}>${e.dst}`] = e.edge.weight;
      return out;
    };
    const before = await edges();
    expect(Object.keys(before).length).toBeGreaterThan(0);
    await merge(n, 'raise');
    const after = await edges();
    for (const [k, w] of Object.entries(before)) expect(after[k]).toBeGreaterThan(w);
  });
});
