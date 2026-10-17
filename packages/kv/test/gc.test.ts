import { describe, expect, test } from 'vitest';
import {
  HybridLogicalClock,
  SeededRandom,
  UlidGenerator,
  keyPrefix,
  prefixRange,
} from '@mindlog/core';
import { GcJob, createKvRegistry, deadGenerationPrefix } from '@mindlog/kv';
import { CommandStamper } from '@mindlog/statemachine';
import { kvNode } from './support/kv-node.js';

/** Raw rows of tenant `t`: every stored version of its keys and elements. */
async function rawCount(store: Awaited<ReturnType<typeof kvNode>>['store']) {
  const prefix = keyPrefix('t');
  if (!prefix.ok) throw new Error(prefix.error.message);
  let n = 0;
  for await (const _ of store.iterate({
    start: prefix.value,
    end: new Uint8Array([...prefix.value, 0xff]),
  }))
    n++;
  return n;
}

function gcJob(node: Awaited<ReturnType<typeof kvNode>>, retainMs: bigint, limit = 1000) {
  return new GcJob({
    proposer: node.proposer,
    stamper: new CommandStamper(
      new HybridLogicalClock(node.clock, { maxOffsetMs: 500n }),
      new UlidGenerator(node.clock, new SeededRandom(5n)),
    ),
    appliedIndex: () => node.machine.appliedIndex,
    clock: node.clock,
    logger: node.logger,
    metrics: node.metrics,
    retainMs,
    idleEntries: 1n,
    limit,
  });
}

describe('garbage collection', () => {
  test('reclaims dead generations and old versions without changing what is visible', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('HSET', 'h', ...Array.from({ length: 20 }, (_, i) => [`f${i}`, 'v']).flat());
    await node.run('DEL', 'h');
    for (let i = 0; i < 10; i++) await node.run('SET', 'counter', String(i));
    await node.run('HSET', 'h', 'fresh', '1');
    const before = await rawCount(node.store);
    node.clock.advance(10n);

    // One job: a fresh job per run would reuse request ids and hit idempotency.
    const job = gcJob(node, 5n, 7);
    let removed = 0;
    for (let i = 0; i < 20; i++) removed += await job.runOnce();
    expect(removed).toBeGreaterThan(20);
    expect(await rawCount(node.store)).toBeLessThan(before - 20);
    for await (const _ of node.store.iterate(prefixRange(deadGenerationPrefix(1n)))) {
      throw new Error('dead generation records should be gone');
    }
    expect(await node.run('HGETALL', 'h')).toEqual({ map: [['fresh', '1']] });
    expect(await node.run('GET', 'counter')).toBe('9');
    expect(node.metrics.value('mindlog_kv_gc_removed_total')).toBe(removed);
  });

  test('keeps history newer than the retention window', async () => {
    const node = await kvNode(createKvRegistry());
    await node.run('SET', 'a', '1');
    await node.run('SET', 'a', '2');
    expect(await gcJob(node, 1000n).runOnce()).toBe(0);
    expect(await node.run('GET', 'a')).toBe('2');
  });
});
