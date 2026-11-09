import { ManualClock, MemoryMetrics, ok } from '@mindlog/core';
import { describe, expect, test } from 'vitest';
import type { Quotas, TenantRecord } from '../src/index.js';
import { TenantGovernor, meterModels, modelTenant } from '../src/index.js';

function governorWith(quotas: Quotas | undefined) {
  const clock = new ManualClock(1_000_000n);
  const record: TenantRecord | undefined = quotas && {
    info: {
      name: 't',
      status: 'active',
      created: '',
      quotas,
      redaction: { enabled: false, kinds: [] },
      auditRetentionDays: 90,
    },
    policies: [],
  };
  const g = new TenantGovernor({
    tenant: () => Promise.resolve(ok(record)),
    clock,
    metrics: new MemoryMetrics(),
  });
  return { g, clock };
}
const budget = (tenant: string, bytes: number, keys: number, memories: number, share = 1) => ({
  tenant,
  share,
  bytes,
  keys,
  memories,
});

describe('TenantGovernor', () => {
  test('an unregistered tenant is never limited', async () => {
    const { g } = governorWith(undefined);
    for (let i = 0; i < 100; i++) expect((await g.admit('t', 'write')).ok).toBe(true);
  });

  test('write rate refills with time', async () => {
    const { g, clock } = governorWith({ writeQps: 2 });
    expect((await g.admit('t', 'write')).ok).toBe(true);
    expect((await g.admit('t', 'write')).ok).toBe(true);
    const refused = await g.admit('t', 'write');
    expect(!refused.ok && refused.error.code).toBe('RATE_LIMITED');
    clock.advance(1_000n);
    expect((await g.admit('t', 'write')).ok).toBe(true);
  });

  test('a share scales the local rate', async () => {
    const { g } = governorWith({ recallQps: 10 });
    g.applyBudgets([budget('t', 0, 0, 0, 0.2)]);
    expect((await g.admit('t', 'recall')).ok).toBe(true);
    expect((await g.admit('t', 'recall')).ok).toBe(true);
    expect((await g.admit('t', 'recall')).ok).toBe(false);
  });

  test('storage, key and memory quotas refuse growth but not deletes', async () => {
    const { g } = governorWith({ storageBytes: 100, keys: 5, memories: 3 });
    g.applyBudgets([budget('t', 100, 0, 0)]);
    const full = await g.admit('t', 'write');
    expect(!full.ok && full.error.code).toBe('QUOTA_EXCEEDED');
    expect((await g.admit('t', 'free')).ok).toBe(true);
    g.applyBudgets([budget('t', 1, 5, 0)]);
    expect((await g.admit('t', 'write')).ok).toBe(false);
    expect((await g.admit('t', 'memory')).ok).toBe(true);
    g.applyBudgets([budget('t', 1, 0, 3)]);
    expect((await g.admit('t', 'memory')).ok).toBe(false);
    expect((await g.admit('t', 'recall')).ok).toBe(true);
  });

  test('model time goes negative, then refills', async () => {
    const { g, clock } = governorWith({ modelSecondsPerHour: 3600 });
    expect((await g.admit('t', 'recall')).ok).toBe(true);
    await g.spendModel('t', 3_600_500);
    const out = await g.admit('t', 'recall');
    expect(!out.ok && out.error.code).toBe('QUOTA_EXCEEDED');
    clock.advance(1_000n);
    expect((await g.admit('t', 'recall')).ok).toBe(true);
  });

  test('connection slots are limited and released once', async () => {
    const { g } = governorWith({ connections: 1 });
    const first = await g.acquireConnection('t');
    if (!first.ok) throw new Error('slot');
    expect((await g.acquireConnection('t')).ok).toBe(false);
    first.value();
    first.value();
    const second = await g.acquireConnection('t');
    expect(second.ok).toBe(true);
    expect((await g.acquireConnection('t')).ok).toBe(false);
  });

  test('demand is reported per second and then reset', async () => {
    const { g, clock } = governorWith({ writeQps: 100 });
    await g.admit('t', 'write');
    await g.admit('t', 'recall');
    clock.advance(2_000n);
    expect(g.drainDemand()).toEqual([{ tenant: 't', writeQps: 0.5, recallQps: 0.5 }]);
    expect(g.drainDemand()).toEqual([]);
  });
});

test('model calls are charged to the tenant they ran for', async () => {
  const clock = new ManualClock(0n);
  const spent: [string, number][] = [];
  const models = meterModels(
    {
      embed: () => {
        clock.advance(5n);
        return Promise.resolve('v');
      },
    },
    clock,
    (tenant, ms) => spent.push([tenant, ms]),
  );
  await models.embed();
  expect(spent).toEqual([]);
  expect(await modelTenant.run('t', () => models.embed())).toBe('v');
  expect(spent).toHaveLength(1);
  expect(spent[0]?.[0]).toBe('t');
});
