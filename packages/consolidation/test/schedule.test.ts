import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CONSOLIDATION_CONFIG, ModelBudget, planTick } from '@mindlog/consolidation';
import { LIFECYCLE_JOBS } from '@mindlog/memory';
import { ScopeLifecycleSchema } from '@mindlog/proto';

const NOW = 1_000_000_000_000n;
const MIN = 60_000n;
const facts = { running: new Set<string>(), hasCache: false, coldTier: true };
const kinds = (p: ReturnType<typeof planTick>) => p.due.map((d) => d.kind).sort();

describe('planTick', () => {
  test('sleep waits for enough new memories and an idle scope, or a day', () => {
    const busy = create(ScopeLifecycleSchema, {
      writesSinceSleep: 25,
      lastWriteMs: NOW - MIN,
      lastRunMs: { [LIFECYCLE_JOBS.sleep]: NOW - 2n * MIN },
    });
    expect(kinds(planTick(busy, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts))).not.toContain(
      LIFECYCLE_JOBS.sleep,
    );
    const idle = create(ScopeLifecycleSchema, {
      writesSinceSleep: 25,
      lastWriteMs: NOW - 11n * MIN,
      lastRunMs: { [LIFECYCLE_JOBS.sleep]: NOW - MIN },
    });
    expect(kinds(planTick(idle, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts))).toContain(
      LIFECYCLE_JOBS.sleep,
    );
    const few = create(ScopeLifecycleSchema, {
      writesSinceSleep: 3,
      lastWriteMs: NOW - 11n * MIN,
      lastRunMs: { [LIFECYCLE_JOBS.sleep]: NOW - 25n * 60n * MIN },
    });
    const plan = planTick(few, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts);
    expect(plan.due.find((d) => d.kind === LIFECYCLE_JOBS.sleep)?.why).toMatch(/a day/);
  });

  test('themes need 5% graph growth; forgetting is hourly; running kinds are skipped', () => {
    const s = create(ScopeLifecycleSchema, {
      hot: 10,
      graphSize: 104,
      graphSizeAtTheme: 100,
      lastRunMs: { [LIFECYCLE_JOBS.forget]: NOW - 30n * MIN },
    });
    expect(kinds(planTick(s, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts))).toEqual([]);
    s.graphSize = 106;
    s.lastRunMs[LIFECYCLE_JOBS.forget] = NOW - 61n * MIN;
    expect(kinds(planTick(s, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts))).toEqual([
      LIFECYCLE_JOBS.forget,
      LIFECYCLE_JOBS.themes,
    ]);
    const running = { ...facts, running: new Set([LIFECYCLE_JOBS.themes]) };
    expect(kinds(planTick(s, NOW, DEFAULT_CONSOLIDATION_CONFIG, running))).toEqual([
      LIFECYCLE_JOBS.forget,
    ]);
  });

  test('a scope with nothing hot and no cache stops ticking', () => {
    const empty = create(ScopeLifecycleSchema, { cold: 5 });
    expect(planTick(empty, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts)).toEqual({
      due: [],
      again: false,
    });
    const cached = planTick(empty, NOW, DEFAULT_CONSOLIDATION_CONFIG, { ...facts, hasCache: true });
    expect(cached.again).toBe(true);
    expect(kinds(cached)).toEqual([LIFECYCLE_JOBS.cache]);
  });

  test('re-embedding and evolution follow their marks', () => {
    const s = create(ScopeLifecycleSchema, { reembed: true, writesSinceEvolve: 2 });
    expect(kinds(planTick(s, NOW, DEFAULT_CONSOLIDATION_CONFIG, facts))).toEqual([
      LIFECYCLE_JOBS.evolve,
      LIFECYCLE_JOBS.reembed,
    ]);
  });
});

describe('ModelBudget', () => {
  test('spends, refills over the hour and says how long to wait', () => {
    let now = 0;
    const b = new ModelBudget(60, () => now); // 60 s per hour
    expect(b.available('t')).toBe(true);
    b.spend('t', 90_000);
    expect(b.available('t')).toBe(false);
    expect(b.waitMs('t')).toBeGreaterThan(0);
    now += b.waitMs('t');
    expect(b.available('t')).toBe(true);
    expect(b.available('other')).toBe(true);
    expect(new ModelBudget(0, () => now).available('t')).toBe(true);
  });
});
