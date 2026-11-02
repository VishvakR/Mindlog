import { describe, expect, test } from 'vitest';
import { MemoryBlobStore } from '@mindlog/blob';
import { OtelTracer } from '@mindlog/core';
import { create } from '@bufbuild/protobuf';
import {
  LIFECYCLE_JOBS,
  MemoryEngine,
  MemoryReads,
  encodeSegment,
  stubText,
  vectorKey,
} from '@mindlog/memory';
import { JobState, TierMoveSchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { TENANT, ctx, memoryNode, scope } from './support/memory-node.js';

type Node = Awaited<ReturnType<typeof memoryNode>>;

async function remember(n: Node, content: string, extra: Record<string, unknown> = {}) {
  const r = await n.engine.remember(
    n.range,
    { scope: scope(), content, kind: 'semantic', ...extra },
    ctx,
  );
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Moves memories cold the way the forgetting worker does: segment first, then the command. */
async function goCold(n: Node, blob: MemoryBlobStore, ids: string[]) {
  const reads = new MemoryReads(n.range.reader, TENANT, 'u1');
  const entries = [];
  for (const id of ids) {
    const record = await reads.record(id);
    const vector = await reads.vector(id);
    if (!record) throw new Error(id);
    entries.push({
      record,
      vector: vector?.vector ?? new Uint8Array(),
      modelId: vector?.modelId ?? '',
    });
  }
  const seg = encodeSegment(TENANT, 'u1', entries);
  expect((await blob.put(seg.key, seg.bytes)).ok).toBe(true);
  const r = await n.engine.maintain(
    n.range,
    scope(),
    {
      tier: entries.map((e) =>
        create(TierMoveSchema, {
          id: e.record.id,
          tier: 'cold',
          segment: seg.key,
          sha256: seg.sha256,
          text: stubText(e.record.text),
        }),
      ),
    },
    ctx,
  );
  expect(r.ok).toBe(true);
}

describe('lifecycle in the engine', () => {
  test('a main remember schedules one consolidation tick for the scope', async () => {
    const n = await memoryNode();
    await remember(n, 'Ana lives in Lisbon.');
    await remember(n, 'Ana works at Acme.');
    const { jobs } = await n.engine.jobs(n.range, scope(), { limit: 10 });
    expect(jobs.filter((j) => j.kind === LIFECYCLE_JOBS.tick)).toHaveLength(1);
    expect(jobs[0]?.state).toBe(JobState.QUEUED);
    expect((await n.engine.lifecycle(n.range, scope())).hot).toBe(2);
  });

  test('no tick when consolidation is off', async () => {
    const n = await memoryNode({ config: { tickDelayMs: 0 } });
    await remember(n, 'Ana lives in Lisbon.');
    expect((await n.engine.jobs(n.range, scope(), { limit: 10 })).jobs).toEqual([]);
  });

  test('recalls strengthen what they return once flushed', async () => {
    const n = await memoryNode();
    const { ids } = await remember(n, 'Ana lives in Lisbon.');
    const before = await n.engine.get(n.range, scope(), ids[0] ?? '');
    n.clock.advance(2n * 86_400_000n);
    const r = await n.engine.recall(n.range, { scope: scope(), query: 'where does Ana live' }, ctx);
    expect(r.ok && r.value.items.map((i) => i.memory.id)).toContain(ids[0]);
    await n.engine.flushRecallStats();
    const after = await n.engine.get(n.range, scope(), ids[0] ?? '');
    expect(after.ok && after.value?.recallCount).toBe(1);
    expect(
      after.ok && before.ok && (after.value?.strength ?? 0) > (before.value?.strength ?? 0),
    ).toBe(true);
  });

  test('ASOF and branch recalls do not count as recalls', async () => {
    const n = await memoryNode();
    const { ids } = await remember(n, 'Ana lives in Lisbon.');
    n.clock.advance(1000n);
    await n.engine.recall(
      n.range,
      { scope: scope(), query: 'Ana', asOf: { timeMs: Number(n.clock.now()) } },
      ctx,
    );
    await n.engine.flushRecallStats();
    const v = await n.engine.get(n.range, scope(), ids[0] ?? '');
    expect(v.ok && v.value?.recallCount).toBe(0);
  });

  test('a cold memory is left out of recall unless INCLUDE_COLD, then comes back hot', async () => {
    const blob = new MemoryBlobStore();
    const n = await memoryNode({ cold: blob });
    const { ids } = await remember(n, 'Ana lives in Lisbon. She moved there in May.');
    const id = ids[0] ?? '';
    await goCold(n, blob, [id]);
    const stub = await n.engine.get(n.range, scope(), id);
    expect(stub.ok && stub.value).toMatchObject({ tier: 'cold', text: 'Ana lives in Lisbon.' });
    expect(await new MvccReader(n.store).get(vectorKey(TENANT, 'u1', id))).toBeUndefined();

    const plain = await n.engine.recall(n.range, { scope: scope(), query: 'Ana Lisbon' }, ctx);
    expect(plain.ok && plain.value.items.map((i) => i.memory.id)).not.toContain(id);
    const cold = await n.engine.recall(
      n.range,
      { scope: scope(), query: 'Ana Lisbon', includeCold: true },
      ctx,
    );
    const hit = cold.ok ? cold.value.items.find((i) => i.memory.id === id) : undefined;
    expect(hit?.memory).toMatchObject({
      tier: 'cold',
      text: 'Ana lives in Lisbon. She moved there in May.',
    });
    await n.engine.flushRecallStats();
    const back = await n.engine.get(n.range, scope(), id);
    expect(back.ok && back.value).toMatchObject({
      tier: 'hot',
      text: 'Ana lives in Lisbon. She moved there in May.',
      recallCount: 1,
    });
    expect(await new MvccReader(n.store).get(vectorKey(TENANT, 'u1', id))).toBeDefined();
  });

  test('an altered segment is never read back', async () => {
    const blob = new MemoryBlobStore();
    const n = await memoryNode({ cold: blob });
    const { ids } = await remember(n, 'Ana lives in Lisbon.');
    await goCold(n, blob, [ids[0] ?? '']);
    const key = blob.keys()[0] ?? '';
    await blob.put(key, new Uint8Array([1, 2, 3]));
    const promoted = await n.engine.promote(n.range, scope(), [ids[0] ?? ''], ctx);
    expect(promoted.ok).toBe(false);
  });

  test('a pinned memory reports pinned and a tool trace is stored as one trace', async () => {
    const n = await memoryNode();
    const { ids } = await remember(n, 'Ana lives in Lisbon.');
    await n.engine.pin(n.range, scope(), [ids[0] ?? ''], true, ctx);
    const v = await n.engine.get(n.range, scope(), ids[0] ?? '');
    expect(v.ok && v.value?.pinned).toBe(true);

    const trace = await n.engine.remember(
      n.range,
      {
        scope: scope(),
        content: '',
        toolTrace: {
          tool: 'git',
          args: { cmd: 'status' },
          result: 'x'.repeat(5000),
          success: true,
        },
      },
      ctx,
    );
    expect(trace.ok).toBe(true);
    if (!trace.ok) return;
    expect(trace.value.memories).toHaveLength(1);
    expect(trace.value.memories[0]).toMatchObject({ kind: 'tool_trace' });
    expect(trace.value.memories[0]?.text).toMatch(/^Tool git succeeded\./);
    expect(trace.value.memories[0]?.text.length).toBeLessThan(1200);
    expect(trace.value.memories[0]?.tags).toEqual(['tool:git', 'success']);
  });

  test('promote needs a cold tier; without models a promoted memory waits for re-embedding', async () => {
    const none = await memoryNode();
    const r = await none.engine.promote(none.range, scope(), ['x'], ctx);
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');

    const blob = new MemoryBlobStore();
    const n = await memoryNode({ cold: blob });
    const { ids } = await remember(n, 'Ana lives in Lisbon.');
    const id = ids[0] ?? '';
    await goCold(n, blob, [id]);
    // A changed model: the segment's vector no longer fits and the models are down.
    await remember(n, 'Bruno lives in Porto.');
    n.models.down = true;
    const reads = new MemoryReads(n.range.reader, TENANT, 'u1');
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state.embedModel).toBe('fake-embed@1');
    const segment = (await reads.record(id))?.coldSegment ?? '';
    const bytes = await blob.get(segment);
    expect(bytes.ok && bytes.value).toBeTruthy();
    const moved = await n.engine.promote(n.range, scope(), [id, id, 'missing'], ctx);
    expect(moved.ok && moved.value.ids).toEqual([id]);
    expect((await reads.record(id))?.tier).toBe('hot');
  });

  test('consolidate enqueues the named workers once, and jobs pages and filters', async () => {
    const n = await memoryNode();
    await remember(n, 'Ana lives in Lisbon.');
    const first = await n.engine.consolidate(
      n.range,
      scope(),
      [LIFECYCLE_JOBS.dedup, LIFECYCLE_JOBS.themes],
      ctx,
    );
    expect(first.ok && first.value.enqueued).toEqual([LIFECYCLE_JOBS.dedup, LIFECYCLE_JOBS.themes]);
    const again = await n.engine.consolidate(n.range, scope(), [LIFECYCLE_JOBS.dedup], ctx);
    expect(again.ok && again.value.enqueued).toEqual([]);
    const all = await n.engine.consolidate(n.range, scope(), undefined, ctx);
    expect(all.ok && all.value.enqueued).not.toContain(LIFECYCLE_JOBS.reembed);
    const page = await n.engine.jobs(n.range, scope(), { limit: 2 });
    expect(page.jobs).toHaveLength(2);
    expect(page.next).toBeDefined();
    const rest = await n.engine.jobs(n.range, scope(), { limit: 50, after: page.next });
    expect(rest.jobs.length).toBeGreaterThan(0);
    const dead = await n.engine.jobs(n.range, scope(), { limit: 50, state: JobState.DEAD });
    expect(dead.jobs).toEqual([]);
  });

  test('maintenance waits for cluster version 8, and recall then records nothing', async () => {
    const n = await memoryNode();
    const off = new MemoryEngine({
      models: n.models,
      stamper: n.stamper,
      ids: { next: () => 'X' },
      clock: n.clock,
      metrics: n.metrics,
      logger: n.logger,
      tracer: new OtelTracer(),
      vectors: n.vectors,
      ranges: () => n.range,
      lifecycle: () => false,
      config: { recallStatsMs: 0 },
    });
    const r = await off.pin(n.range, scope(), ['x'], true, ctx);
    expect(!r.ok && r.error.code).toBe('UNAVAILABLE');
    const added = await off.remember(
      n.range,
      { scope: scope(), content: 'Ana likes tea.', kind: 'semantic' },
      ctx,
    );
    expect(added.ok).toBe(true);
    // No tick was scheduled without the lifecycle commands.
    expect((await n.engine.jobs(n.range, scope(), { limit: 10 })).jobs).toEqual([]);
  });
});
