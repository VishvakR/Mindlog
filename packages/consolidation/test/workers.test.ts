import { fromBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { entryPrefix } from '@mindlog/cache';
import { CacheEntrySchema } from '@mindlog/proto';
import { MvccReader } from '@mindlog/storage';
import { LIFECYCLE_JOBS, MemoryReads } from '@mindlog/memory';
import type { Embeddings } from '@mindlog/models-client';
import { FakeModels } from '@mindlog/models-client';
import { DAY, ctx, lifecycleNode, scope } from './support/node.js';

const MIN = 60_000n;

async function memories(n: Awaited<ReturnType<typeof lifecycleNode>>, extra = {}) {
  const r = await n.engine.list(n.range, scope(), {
    limit: 500,
    includeForgotten: false,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.memories;
}

describe('consolidation workers', () => {
  test('the tick enqueues due workers and reschedules itself', async () => {
    const n = await lifecycleNode();
    await n.remember('Ana lives in Lisbon.', { kind: 'semantic' });
    n.clock.advance(11n * MIN);
    await n.runner.runOnce(); // the tick
    const { jobs } = await n.engine.jobs(n.range, scope(), { limit: 50 });
    const kinds = jobs.map((j) => j.kind);
    expect(kinds).toContain(LIFECYCLE_JOBS.tick); // the next one
    expect(kinds).toContain(LIFECYCLE_JOBS.forget);
    expect(kinds).toContain(LIFECYCLE_JOBS.evolve);
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state.writesSinceEvolve).toBe(0);
    expect(state.tickAtMs).toBeGreaterThan(n.clock.now());
  });

  test('sleep-time distils sessions on a branch and merges it', async () => {
    const n = await lifecycleNode();
    for (const s of ['s1', 's2'])
      for (let i = 0; i < 12; i++)
        await n.remember(`In session ${s} the user said fact number ${String(i)} about tea.`, {
          kind: 'episodic',
          scope: scope('u1', { session: s }),
        });
    n.clock.advance(11n * MIN);
    await n.drain();
    const learned = (await memories(n)).filter((m) => m.tags.includes('learned-context'));
    expect(learned.length).toBe(2);
    expect(learned[0]?.source.type).toBe('consolidation');
    expect(learned[0]?.links.some((l) => l.relation === 'derived_from')).toBe(true);
    const branches = await n.engine.branches(n.range, scope());
    expect(branches.ok && branches.value.map((b) => b.status)).toEqual(['merged']);
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state.checkpoints[LIFECYCLE_JOBS.sleep]).not.toBe('');
  });

  test('sleep-time drops its branch when the merge would raise too many conflicts', async () => {
    const n = await lifecycleNode({
      consolidation: { maxConflicts: 0 },
      memory: { conflictThreshold: 0.5, conflictMinSimilarity: 0 },
    });
    await n.remember('The user likes tea.', { kind: 'semantic' });
    for (let i = 0; i < 21; i++)
      await n.remember('The user does not like tea.', {
        kind: 'episodic',
        scope: scope('u1', { session: 's1' }),
      });
    n.clock.advance(11n * MIN);
    await n.drain();
    const branches = await n.engine.branches(n.range, scope());
    expect(branches.ok && branches.value.map((b) => b.status)).toEqual(['dropped']);
    expect((await memories(n)).some((m) => m.tags.includes('learned-context'))).toBe(false);
  });

  test('faded memories go cold, pinned ones stay, and a cold memory keeps a stub', async () => {
    const n = await lifecycleNode();
    const a = await n.remember('Ana lives in Lisbon.', { kind: 'semantic' });
    const b = await n.remember('Ana works at Acme.', { kind: 'semantic' });
    await n.engine.pin(n.range, scope(), [b.ids[0] ?? ''], true, { principal: 'p' });
    n.clock.advance(60n * DAY);
    await n.drain();
    const all = await memories(n);
    expect(all.find((m) => m.id === a.ids[0])?.tier).toBe('cold');
    expect(all.find((m) => m.id === b.ids[0])?.tier).toBe('hot');
    expect(n.blob?.keys().length).toBe(1);
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state).toMatchObject({ hot: 1, cold: 1 });
  });

  test('hard forgetting deletes faded unimportant memories only for allowed tenants', async () => {
    const n = await lifecycleNode({ consolidation: { hardForgetTenants: ['acme'] } });
    const small = await n.remember('ok sure', { kind: 'episodic' });
    const big = await n.remember('I always prefer my decisions recorded.', { kind: 'semantic' });
    // Heuristic importance is at least 0.3; dedup halving is what brings memories below 0.2.
    await n.engine.maintain(
      n.range,
      scope(),
      { evolve: [{ id: small.ids[0] ?? '', importance: 0.1, setImportance: true }] },
      { principal: 'p' },
    );
    n.clock.advance(400n * DAY);
    await n.drain();
    const live = await memories(n);
    expect(live.map((m) => m.id)).not.toContain(small.ids[0]);
    expect(live.map((m) => m.id)).toContain(big.ids[0]);
    const gone = await n.engine.get(n.range, scope(), small.ids[0] ?? '');
    expect(gone.ok && gone.value?.forgetReason).toBe('forgetting curve');
  });

  test('dedup marks the newer of two near-identical memories', async () => {
    const n = await lifecycleNode({ memory: { duplicateThreshold: 1.1 } });
    const a = await n.remember('Ana lives in Lisbon with her cat.', { kind: 'semantic' });
    const b = await n.remember('Ana lives in Lisbon with her cat!', { kind: 'semantic' });
    n.clock.advance(11n * MIN);
    await n.drain();
    const all = await memories(n);
    const newer = all.find((m) => m.id === b.ids[0]);
    expect(newer?.tags).toContain('duplicate');
    expect(newer?.meta).toMatchObject({ duplicateOf: a.ids[0] });
    expect(all.find((m) => m.id === a.ids[0])?.links.map((l) => l.relation)).toContain(
      'supersedes',
    );
  });

  test('themes become theme memories linked to their members', async () => {
    const n = await lifecycleNode();
    for (const t of [
      'Ana and Bruno met Carla in Lisbon.',
      'Ana, Bruno and Carla run Acme.',
      'Bruno told Carla about Ana.',
      'Dmitri and Elena visited Faro with Gustavo.',
      'Elena, Gustavo and Dmitri sail at Faro.',
      'Gustavo and Dmitri cook with Elena.',
    ])
      await n.remember(t, { kind: 'semantic' });
    n.clock.advance(11n * MIN);
    await n.drain();
    const themes = (await memories(n)).filter((m) => m.kind === 'theme');
    expect(themes.length).toBeGreaterThanOrEqual(1);
    expect(themes[0]?.text).toMatch(/^Theme \(/);
    expect(themes[0]?.links.filter((l) => l.relation === 'related').length).toBeGreaterThan(1);
    // Theme memories do not grow the graph counter, so the next tick does not rebuild them.
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state.graphSize).toBe(state.graphSizeAtTheme);
    n.clock.advance(20n * MIN);
    await n.drain();
    const again = (await memories(n)).filter((m) => m.kind === 'theme');
    expect(again.map((m) => m.id)).toEqual(themes.map((m) => m.id));
  });

  test('evolution gives linked older memories the new entities as tags and a context', async () => {
    const n = await lifecycleNode({ memory: { linkThreshold: 0.3 } });
    const old = await n.remember('Ana likes green tea in the morning.', { kind: 'semantic' });
    await n.remember('Ana buys green tea from Bruno in Porto.', { kind: 'semantic' });
    n.clock.advance(11n * MIN);
    await n.drain();
    const v = await n.engine.get(n.range, scope(), old.ids[0] ?? '');
    expect(v.ok && v.value?.version).toBeGreaterThan(1);
    expect(v.ok && v.value?.meta).toHaveProperty('context');
  });

  test('a scope that switches embedding models is re-embedded', async () => {
    class Renamed extends FakeModels {
      model = 'fake-embed@1';
      override async embed(...a: Parameters<FakeModels['embed']>) {
        const r = await super.embed(...a);
        return r.ok
          ? { ok: true as const, value: { ...r.value, modelId: this.model } as Embeddings }
          : r;
      }
    }
    const models = new Renamed();
    const n = await lifecycleNode({ models });
    const first = await n.remember('Ana lives in Lisbon.', { kind: 'semantic' });
    models.model = 'fake-embed@2';
    await n.remember('Bruno lives in Porto.', { kind: 'semantic' });
    expect((await n.engine.lifecycle(n.range, scope())).reembed).toBe(true);
    n.clock.advance(11n * MIN);
    await n.drain();
    const state = await n.engine.lifecycle(n.range, scope());
    expect(state).toMatchObject({ reembed: false, embedModel: 'fake-embed@2' });
    const reads = (await import('@mindlog/memory')).MemoryReads;
    const v = await new reads(n.range.reader, 'acme', 'u1').vector(first.ids[0] ?? '');
    expect(v?.modelId).toBe('fake-embed@2');
  });

  test('a tenant out of model budget defers its workers without counting attempts', async () => {
    const n = await lifecycleNode({ consolidation: { modelSecondsPerHour: 1e-9 } });
    for (let i = 0; i < 21; i++)
      await n.remember(`Turn ${String(i)} of a long talk.`, {
        kind: 'episodic',
        scope: scope('u1', { session: 's1' }),
      });
    n.clock.advance(11n * MIN);
    await n.drain();
    // The first model call spends the budget; the next worker needing one is deferred.
    const { jobs } = await n.engine.jobs(n.range, scope(), { limit: 50 });
    const deferredJobs = jobs.filter((j) => j.deferrals > 0);
    expect(deferredJobs.length).toBeGreaterThan(0);
    for (const j of deferredJobs) {
      expect(j.error).toBe('');
      expect(j.runAtMs).toBeGreaterThan(n.clock.now());
    }
  });

  test('the cache janitor drops expired entries and keeps live ones', async () => {
    const n = await lifecycleNode();
    await n.remember('Ana lives in Lisbon.', { kind: 'semantic' });
    const entry = (id: string, expiresAtMs: bigint) => ({
      case: 'cacheSet' as const,
      value: { user: 'u1', entry: { id, prompt: id, answer: 'a', expiresAtMs }, maxEntries: 10 },
    });
    await n.propose(entry('old', n.clock.now() + 1000n));
    await n.propose(entry('forever', 0n));
    n.clock.advance(10n * MIN);
    const r = await n.engine.consolidate(n.range, scope(), [LIFECYCLE_JOBS.cache], ctx);
    expect(r.ok).toBe(true);
    await n.drain();
    const left: string[] = [];
    for await (const { value } of new MvccReader(n.store).scan(entryPrefix('acme', 'u1')))
      left.push(fromBinary(CacheEntrySchema, value).id);
    expect(left).toEqual(['forever']);
  });

  test('an entity mentioned five times gets a summary', async () => {
    const n = await lifecycleNode();
    for (const t of [
      'My friend Ana lives in Lisbon.',
      'Since 2020 Ana works at the bakery.',
      'Every day Ana drinks green tea.',
      'On weekends Ana runs by the river.',
      'At night Ana plays the cello.',
      'In spring Ana visited the islands.',
    ])
      await n.remember(t, { kind: 'semantic' });
    await n.engine.consolidate(n.range, scope(), [LIFECYCLE_JOBS.entities], ctx);
    await n.drain();
    const summaries: string[] = [];
    for await (const { entity } of new MemoryReads(n.range.reader, 'acme', 'u1').entities())
      if (entity.summary) summaries.push(`${entity.name}: ${entity.summary}`);
    expect(summaries.some((x) => x.startsWith('Ana: '))).toBe(true);
  });

  test('re-embedding fails while models are down, and finishes once they are back', async () => {
    class Renamed extends FakeModels {
      model = 'fake-embed@1';
      override async embed(...a: Parameters<FakeModels['embed']>) {
        const r = await super.embed(...a);
        return r.ok
          ? { ok: true as const, value: { ...r.value, modelId: this.model } as Embeddings }
          : r;
      }
    }
    const models = new Renamed();
    const n = await lifecycleNode({ models, memory: { tickDelayMs: 0 } });
    for (let i = 0; i < 40; i++)
      await n.remember(`Fact ${String(i)} about tea.`, { kind: 'semantic' });
    models.model = 'fake-embed@2';
    await n.remember('Bruno lives in Porto.', { kind: 'semantic' });
    models.down = true;
    await n.engine.consolidate(n.range, scope(), [LIFECYCLE_JOBS.reembed], ctx);
    await n.runner.runOnce();
    const failed = (await n.engine.jobs(n.range, scope(), { limit: 10 })).jobs[0];
    expect(failed?.error).toMatch(/UNAVAILABLE/);
    models.down = false;
    n.clock.advance(MIN);
    await n.drain();
    expect(await n.engine.lifecycle(n.range, scope())).toMatchObject({
      reembed: false,
      embedModel: 'fake-embed@2',
    });
  });
});
