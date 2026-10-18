import { describe, expect, test } from 'vitest';
import { MemoryLogger, MemoryMetrics, SystemClock, resolveConfig } from '@mindlog/core';
import type { NodeCore } from '@mindlog/server';
import { openNodeCore } from '@mindlog/server';
import { NodeState } from '@mindlog/proto';
import { tempDir } from './support/temp-dir.js';

async function open(dataDir: string, extra: Record<string, unknown> = {}): Promise<NodeCore> {
  const config = resolveConfig({ flags: { node: { dataDir }, ...extra } });
  if (!config.ok) throw new Error(config.error.message);
  const core = await openNodeCore(config.value, {
    logger: new MemoryLogger(),
    metrics: new MemoryMetrics(),
    clock: new SystemClock(),
    tracer: { withSpan: (_n, _a, fn) => fn({ setAttribute: () => {} }) },
  });
  if (!core.ok) throw new Error(core.error.message);
  return core.value;
}

describe('a single node with its embedded placement driver', () => {
  test('registers itself, reports its range, and learns the cluster version', async () => {
    const core = await open(await tempDir());
    try {
      const { agent, pd } = core;
      if (!agent || !pd) throw new Error('a single node runs its own PD');
      await agent.reportStore();
      await agent.reportRanges();
      const cluster = await pd.service.cluster();
      expect(cluster.ok && cluster.value.nodes.map((n) => [n.nodeId, n.state])).toEqual([
        [1n, NodeState.LIVE],
      ]);
      expect(cluster.ok && cluster.value.ranges.map((r) => r.rangeId)).toEqual([1n]);
      expect(cluster.ok && cluster.value.ranges[0]?.replicas).toHaveLength(1);
      // Timestamps and ids come from the same PD.
      const a = await pd.client.tso(1);
      const b = await pd.client.tso(1);
      expect(a.ok && b.ok && b.value > a.value).toBe(true);
      const id = await pd.client.allocIds(1);
      expect(id.ok && id.value).toBeGreaterThanOrEqual(1000n);
    } finally {
      await core.close();
    }
  });

  test("splits a range on PD's orders once the data outgrows ranges.maxBytes", async () => {
    const core = await open(await tempDir(), {
      ranges: { maxBytes: 3000 },
      pd: { storeHeartbeatMs: 50, rangeHeartbeatMs: 50, schedulerIntervalMs: 50 },
    });
    try {
      const session = core.service.openSession('t');
      const enc = new TextEncoder();
      for (let i = 0; i < 60; i++)
        await core.service.execute(
          session,
          ['SET', `key-${String(i % 6)}`, 'x'.repeat(100)].map((a) => enc.encode(a)),
        );
      const deadline = Date.now() + 20_000;
      while (core.store.replicas().length < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(core.store.replicas().length).toBeGreaterThanOrEqual(2);
      // The directory follows the split, and the node still serves every key.
      const reply = await core.service.execute(
        session,
        ['GET', 'key-3'].map((a) => enc.encode(a)),
      );
      expect(reply.kind.case).toBe('bulk');
    } finally {
      await core.close();
    }
  });

  test('keeps serving MGET, DBSIZE and writes across ranges after a split', async () => {
    const core = await open(await tempDir(), {
      ranges: { maxBytes: 3000 },
      pd: { storeHeartbeatMs: 50, rangeHeartbeatMs: 50, schedulerIntervalMs: 50 },
    });
    try {
      const session = core.service.openSession('t');
      const enc = new TextEncoder();
      const run = (...argv: string[]) =>
        core.service.execute(
          session,
          argv.map((a) => enc.encode(a)),
        );
      const names = ['apple', 'melon', 'zebra', 'quince', 'banana', 'yak'];
      for (let i = 0; i < 60; i++) await run('SET', names[i % 6] as string, 'x'.repeat(100));
      const deadline = Date.now() + 20_000;
      while (core.store.replicas().length < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(core.store.replicas().length).toBeGreaterThanOrEqual(2);
      expect((await run('DBSIZE')).kind).toMatchObject({ case: 'integer', value: 6n });
      const many = await run('MGET', ...names);
      expect(
        many.kind.case === 'array' && many.kind.value.items.every((i) => i.kind.case === 'bulk'),
      ).toBe(true);
      expect((await run('INCR', 'counter-z')).kind).toMatchObject({ case: 'integer', value: 1n });
    } finally {
      await core.close();
    }
  });

  test('with features.crossRangeTxn, MSET across ranges commits atomically', async () => {
    const core = await open(await tempDir(), {
      ranges: { maxBytes: 3000 },
      features: { crossRangeTxn: true },
      pd: { storeHeartbeatMs: 50, rangeHeartbeatMs: 50, schedulerIntervalMs: 50 },
    });
    try {
      const session = core.service.openSession('t');
      const enc = new TextEncoder();
      const run = (...argv: string[]) =>
        core.service.execute(
          session,
          argv.map((a) => enc.encode(a)),
        );
      for (let i = 0; i < 60; i++)
        await run('SET', ['apple', 'melon', 'zebra', 'yak'][i % 4] as string, 'x'.repeat(100));
      const deadline = Date.now() + 20_000;
      while (core.store.replicas().length < 2 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(core.store.replicas().length).toBeGreaterThanOrEqual(2);
      expect((await run('MSET', 'apple', '1', 'zebra', '2')).kind).toMatchObject({
        case: 'simple',
        value: 'OK',
      });
      const got = await run('MGET', 'apple', 'zebra');
      expect(got.kind.case === 'array' && got.kind.value.items.map((i) => i.kind.case)).toEqual([
        'bulk',
        'bulk',
      ]);
    } finally {
      await core.close();
    }
  });
});
