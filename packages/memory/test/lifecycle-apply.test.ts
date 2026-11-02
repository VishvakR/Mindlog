import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { jobKey } from '@mindlog/jobs';
import {
  LIFECYCLE_JOBS,
  entityKey,
  initialStrength,
  lifecycleKey,
  recordKey,
  strengthAfterRecall,
  vectorKey,
  versionKey,
} from '@mindlog/memory';
import type { NewMemory } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import {
  MemoryEntitySchema,
  MemoryRecordSchema,
  NewMemorySchema,
  ScopeLifecycleSchema,
} from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { START, TENANT, memoryNode } from './support/memory-node.js';

const VECTOR = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);

function memory(id: string, model = 'fake@1'): NewMemory {
  return create(NewMemorySchema, {
    record: {
      id,
      user: 'u1',
      kind: 'semantic',
      text: `fact ${id}`,
      trust: 'normal',
      importance: 0.5,
      strength: initialStrength(0.5),
      source: { type: 'user', principal: 'p' },
      embeddingModel: model,
    },
    vector: VECTOR,
    mentions: [{ name: 'Ana', type: 'person' }],
  });
}

async function setup() {
  const n = await memoryNode();
  const reader = new MvccReader(n.store);
  const run = async (body: Parameters<CommandStamper['stamp']>[2]) =>
    n.propose(n.stamper.stamp(TENANT, 'p', body));
  const commit = (memories: NewMemory[], extra: object = {}) =>
    run({ case: 'memoryCommit', value: { user: 'u1', memories, edges: [], ...extra } });
  const maintain = (value: object) =>
    run({ case: 'memoryMaintain', value: { user: 'u1', ...value } });
  const record = async (id: string) => {
    const b = await reader.get(recordKey(TENANT, 'u1', id));
    return b && fromBinary(MemoryRecordSchema, b);
  };
  const state = async () => {
    const b = await reader.get(lifecycleKey(TENANT, 'u1'));
    return b ? fromBinary(ScopeLifecycleSchema, b) : undefined;
  };
  return { n, reader, run, commit, maintain, record, state };
}

describe('lifecycle apply', () => {
  test('a commit counts hot memories, trigger counts and the embedding model', async () => {
    const t = await setup();
    await t.commit([memory('m1'), memory('m2')]);
    expect(await t.state()).toMatchObject({
      hot: 2,
      cold: 0,
      writesSinceSleep: 2,
      writesSinceEvolve: 2,
      graphSize: 2,
      embedModel: 'fake@1',
      reembed: false,
      lastWriteMs: START,
    });
    await t.commit([memory('m3', 'fake@2')]);
    expect(await t.state()).toMatchObject({ embedModel: 'fake@2', reembed: true, hot: 3 });
    await t.run({ case: 'memoryForget', value: { user: 'u1', ids: ['m1'], reason: 'r' } });
    expect((await t.state())?.hot).toBe(2);
  });

  test('memories written by consolidation do not count toward its own triggers', async () => {
    const t = await setup();
    const theme = memory('t1');
    if (theme.record)
      theme.record.source = {
        type: 'consolidation',
        ref: 'themes',
        principal: 'p',
        $typeName: 'mindlog.v1.MemorySource',
      };
    await t.commit([theme]);
    expect(await t.state()).toMatchObject({
      hot: 1,
      writesSinceSleep: 0,
      writesSinceEvolve: 0,
      graphSize: 0,
      lastWriteMs: 0n,
    });
  });

  test('a commit enqueues the scope tick only when none is scheduled', async () => {
    const t = await setup();
    const tick = (id: string) => ({ id, kind: LIFECYCLE_JOBS.tick, runAtMs: START + 600_000n });
    await t.commit([memory('m1')], { tick: tick('tick-1') });
    await t.commit([memory('m2')], { tick: tick('tick-2') });
    expect((await t.state())?.tickAtMs).toBe(START + 600_000n);
    expect(await t.reader.get(jobKey(TENANT, 'u1', 'tick-1'))).toBeDefined();
    expect(await t.reader.get(jobKey(TENANT, 'u1', 'tick-2'))).toBeUndefined();
  });

  test('cold keeps a stub without a vector; hot restores the text and vector', async () => {
    const t = await setup();
    await t.commit([memory('m1')]);
    const cold = await t.maintain({
      tier: [{ id: 'm1', tier: 'cold', segment: 'seg', sha256: 'abc', text: 'stub' }],
    });
    expect(cold.outcome.case === 'memory' && cold.outcome.value.ids).toEqual(['m1']);
    expect(await t.record('m1')).toMatchObject({ tier: 'cold', text: 'stub', coldSegment: 'seg' });
    expect(await t.reader.get(vectorKey(TENANT, 'u1', 'm1'))).toBeUndefined();
    expect(await t.state()).toMatchObject({ hot: 0, cold: 1 });
    // Moving again to the same tier changes nothing.
    const again = await t.maintain({
      tier: [{ id: 'm1', tier: 'cold', segment: 'seg', sha256: 'abc', text: 'stub' }],
    });
    expect(again.outcome.case === 'memory' && again.outcome.value.ids).toEqual([]);
    await t.maintain({
      tier: [{ id: 'm1', tier: 'hot', text: 'fact m1', vector: VECTOR, modelId: 'fake@1' }],
    });
    expect(await t.record('m1')).toMatchObject({ tier: 'hot', text: 'fact m1', coldSegment: '' });
    expect(await t.reader.get(vectorKey(TENANT, 'u1', 'm1'))).toBeDefined();
    expect(await t.state()).toMatchObject({ hot: 1, cold: 0 });
  });

  test('a pinned memory does not go cold, and forgetting a cold one counts it', async () => {
    const t = await setup();
    await t.commit([memory('m1'), memory('m2')]);
    await t.maintain({ pin: [{ id: 'm1', pinned: true }] });
    await t.maintain({
      tier: ['m1', 'm2'].map((id) => ({ id, tier: 'cold', segment: 's', sha256: 'h', text: 'x' })),
    });
    expect((await t.record('m1'))?.tier).toBe('');
    expect((await t.record('m2'))?.tier).toBe('cold');
    await t.run({ case: 'memoryForget', value: { user: 'u1', ids: ['m2'], reason: 'r' } });
    expect(await t.state()).toMatchObject({ hot: 1, cold: 0 });
  });

  test('evolve writes a new version and keeps the old one', async () => {
    const t = await setup();
    await t.commit([memory('m1')]);
    await t.maintain({
      evolve: [
        {
          id: 'm1',
          tags: ['tea'],
          setTags: true,
          metaJson: '{"context":"about drinks"}',
          importance: 0.2,
          setImportance: true,
          addLinks: [{ to: 'm9', relation: 'supersedes', weight: 1 }],
        },
      ],
    });
    const r = await t.record('m1');
    expect(r).toMatchObject({ version: 1, tags: ['tea'], metaJson: '{"context":"about drinks"}' });
    expect(r?.importance).toBeCloseTo(0.2);
    expect(r?.links.map((l) => l.relation)).toEqual(['supersedes']);
    const old = await t.reader.get(versionKey(TENANT, 'u1', 'm1', 0));
    expect(old && fromBinary(MemoryRecordSchema, old).tags).toEqual([]);
  });

  test('invalid maintenance is refused before anything is written', async () => {
    const t = await setup();
    await t.commit([memory('m1')]);
    const before = await t.n.dump();
    for (const body of [
      { evolve: [{ id: 'm1', metaJson: '[1]' }] },
      { tier: [{ id: 'm1', tier: 'warm', text: 'x' }] },
      { tier: [{ id: 'm1', tier: 'cold', text: 'x' }] },
      { complete: { id: 'nope', attempt: 1 }, pin: [{ id: 'm1', pinned: true }] },
    ]) {
      const r = await t.maintain(body);
      expect(r.outcome.case).toBe('error');
    }
    const after = await t.n.dump();
    // Only the idempotency rows of the refused commands differ.
    expect(after.length - before.length).toBeLessThanOrEqual(4);
    expect((await t.record('m1'))?.pinned).toBe(false);
  });

  test('enqueueing a worker resets its trigger and a tick reschedules or stops', async () => {
    const t = await setup();
    await t.commit([memory('m1')], {
      tick: { id: 'tick-1', kind: LIFECYCLE_JOBS.tick, runAtMs: START },
    });
    await t.run({ case: 'jobLease', value: { user: 'u1', id: 'tick-1', leaseMs: 1000n } });
    await t.maintain({
      tick: true,
      complete: { id: 'tick-1', attempt: 1 },
      enqueue: [{ id: 'sleep-1', kind: LIFECYCLE_JOBS.sleep }],
      nextTick: { id: 'tick-2', kind: LIFECYCLE_JOBS.tick, runAtMs: START + 5n },
      checkpointWorker: LIFECYCLE_JOBS.forget,
      checkpoint: 'm1',
    });
    const s = await t.state();
    expect(s).toMatchObject({ writesSinceSleep: 0, tickAtMs: START + 5n });
    expect(s?.lastRunMs[LIFECYCLE_JOBS.sleep]).toBe(START);
    expect(s?.checkpoints[LIFECYCLE_JOBS.forget]).toBe('m1');
    expect(await t.reader.get(jobKey(TENANT, 'u1', 'tick-1'))).toBeUndefined();
    t.n.clock.advance(10n);
    await t.run({ case: 'jobLease', value: { user: 'u1', id: 'tick-2', leaseMs: 1000n } });
    await t.maintain({ tick: true, complete: { id: 'tick-2', attempt: 1 } });
    expect((await t.state())?.tickAtMs).toBe(0n);
  });

  test('reembed replaces vectors with the new model and clears the flag when done', async () => {
    const t = await setup();
    await t.commit([memory('m1'), memory('m2', 'fake@2')]);
    const v2 = new Uint8Array(new Float32Array([0, 1, 0, 0]).buffer);
    await t.maintain({
      reembed: [{ id: 'm1', vector: v2 }],
      reembedModel: 'fake@2',
      reembedDone: true,
    });
    expect((await t.record('m1'))?.embeddingModel).toBe('fake@2');
    expect(await t.state()).toMatchObject({ reembed: false, embedModel: 'fake@2' });
  });

  test('entity summaries, a hot move without a vector, and re-embeds skip what changed', async () => {
    const t = await setup();
    await t.commit([memory('m1'), memory('m2')]);
    await t.maintain({
      entities: [
        { entityId: 'person:ana', summary: 'Ana is a person.' },
        { entityId: 'person:nobody', summary: 'x' },
      ],
    });
    const e = await t.reader.get(entityKey(TENANT, 'u1', 'person:ana'));
    expect(e && fromBinary(MemoryEntitySchema, e)).toMatchObject({
      summary: 'Ana is a person.',
      summaryMentions: 2,
    });
    await t.maintain({
      tier: [{ id: 'm1', tier: 'cold', segment: 's', sha256: 'h', text: 'stub' }],
    });
    // Re-embedding skips cold, forgotten and vector-less entries.
    await t.run({ case: 'memoryForget', value: { user: 'u1', ids: ['m2'], reason: 'r' } });
    const re = await t.maintain({
      reembed: [
        { id: 'm1', vector: VECTOR },
        { id: 'm2', vector: VECTOR },
        { id: 'm3', vector: new Uint8Array() },
      ],
      reembedModel: 'fake@2',
    });
    expect(re.outcome.case === 'memory' && re.outcome.value.ids).toEqual([]);
    await t.maintain({ tier: [{ id: 'm1', tier: 'hot', text: 'back' }] });
    expect(await t.record('m1')).toMatchObject({ tier: 'hot', text: 'back', embeddingModel: '' });
    expect(await t.reader.get(vectorKey(TENANT, 'u1', 'm1'))).toBeUndefined();
    const bad = await t.maintain({ reembed: [{ id: 'm1', vector: new Uint8Array(3) }] });
    expect(bad.outcome.case).toBe('error');
  });

  test('recall stats raise strength by the spacing rule', async () => {
    const t = await setup();
    await t.commit([memory('m1')]);
    const s0 = (await t.record('m1'))?.strength ?? 0;
    t.n.clock.advance(3n * 86_400_000n);
    await t.run({ case: 'memoryRecallStats', value: { user: 'u1', ids: ['m1', 'm1', 'gone'] } });
    const r = await t.record('m1');
    expect(r?.recallCount).toBe(1);
    expect(r?.lastRecalledAt).toBeGreaterThan(0n);
    expect(r?.strength).toBeCloseTo(strengthAfterRecall(s0, 3), 4);
  });

  test('lifecycle commands are refused on a branch', async () => {
    const t = await setup();
    await t.run({ case: 'branchCreate', value: { user: 'u1', name: 'b', maxWrites: 10 } });
    const bodies: Array<Parameters<CommandStamper['stamp']>[2]> = [
      { case: 'memoryMaintain', value: { user: 'u1' } },
      { case: 'memoryRecallStats', value: { user: 'u1', ids: [] } },
    ];
    for (const body of bodies) {
      const c = t.n.stamper.stamp(TENANT, 'p', body);
      c.branch = 'b';
      const r = await t.n.propose(c);
      expect(r.outcome.case === 'error' && r.outcome.value.code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('forgetting curve', () => {
  test('spaced recalls grow strength more than massed ones', () => {
    const massed = [0.01, 0.01, 0.01].reduce((s, d) => strengthAfterRecall(s, d), 2);
    const spaced = [2, 3, 5].reduce((s, d) => strengthAfterRecall(s, d), 2);
    expect(spaced).toBeGreaterThan(massed);
    expect(strengthAfterRecall(2, 100)).toBeCloseTo(3); // capped at ×1.5
    expect(initialStrength(1)).toBe(10);
  });
});
