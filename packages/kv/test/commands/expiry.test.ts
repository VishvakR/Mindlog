import { beforeEach, describe, expect, test } from 'vitest';
import { HybridLogicalClock, SeededRandom, UlidGenerator, prefixRange } from '@mindlog/core';
import { ExpiryJob, createKvRegistry, expiryIndexPrefix } from '@mindlog/kv';
import { CommandStamper } from '@mindlog/statemachine';
import { kvNode } from '../support/kv-node.js';

let node: Awaited<ReturnType<typeof kvNode>>;
beforeEach(async () => {
  node = await kvNode(createKvRegistry());
});

describe('EXPIRE family (Valkey expire.tcl)', () => {
  test('EXPIRE - set timeouts multiple times', async () => {
    await node.run('SET', 'x', 'foobar');
    expect(await node.run('EXPIRE', 'x', '5')).toBe(1);
    expect(await node.run('TTL', 'x')).toBe(5);
    expect(await node.run('EXPIRE', 'x', '10')).toBe(1);
    expect(await node.run('TTL', 'x')).toBe(10);
    node.clock.advance(10_001n);
    expect(await node.run('GET', 'x')).toBeNull();
  });

  test('TTL and PTTL return -2 for missing keys and -1 without expiry', async () => {
    expect(await node.run('TTL', 'missing')).toBe(-2);
    await node.run('SET', 'k', 'v');
    expect(await node.run('TTL', 'k')).toBe(-1);
    expect(await node.run('PTTL', 'k')).toBe(-1);
    await node.run('PEXPIRE', 'k', '1500');
    expect(await node.run('PTTL', 'k')).toBe(1500);
    expect(await node.run('TTL', 'k')).toBe(2);
  });

  test('EXPIREAT / PEXPIREAT / EXPIRETIME / PEXPIRETIME use absolute times', async () => {
    const now = Number(node.clock.now());
    await node.run('SET', 'k', 'v');
    expect(await node.run('PEXPIREAT', 'k', String(now + 2000))).toBe(1);
    expect(await node.run('PEXPIRETIME', 'k')).toBe(now + 2000);
    expect(await node.run('EXPIRETIME', 'k')).toBe(Math.floor((now + 2000) / 1000));
    expect(await node.run('EXPIREAT', 'k', String(Math.floor(now / 1000) + 100))).toBe(1);
  });

  test('a time in the past deletes the key at once', async () => {
    await node.run('SET', 'k', 'v');
    expect(await node.run('EXPIRE', 'k', '-1')).toBe(1);
    expect(await node.run('GET', 'k')).toBeNull();
    expect(await node.run('EXPIRE', 'k', '10')).toBe(0);
  });

  test('NX / XX / GT / LT conditions', async () => {
    await node.run('SET', 'k', 'v');
    expect(await node.run('EXPIRE', 'k', '100', 'XX')).toBe(0);
    expect(await node.run('EXPIRE', 'k', '100', 'GT')).toBe(0);
    expect(await node.run('EXPIRE', 'k', '100', 'LT')).toBe(1);
    expect(await node.run('EXPIRE', 'k', '50', 'NX')).toBe(0);
    expect(await node.run('EXPIRE', 'k', '50', 'GT')).toBe(0);
    expect(await node.run('EXPIRE', 'k', '200', 'GT')).toBe(1);
    expect(await node.run('TTL', 'k')).toBe(200);
    expect(await node.run('EXPIRE', 'k', '10', 'NX', 'XX')).toEqual({
      error: 'INVALID_ARGUMENT NX and XX, GT or LT options at the same time are not compatible',
    });
    expect(await node.run('EXPIRE', 'k', '10', 'GT', 'LT')).toEqual({
      error: 'INVALID_ARGUMENT GT and LT options at the same time are not compatible',
    });
    expect(await node.run('EXPIRE', 'k', '10', 'YY')).toEqual({
      error: 'INVALID_ARGUMENT syntax error',
    });
  });

  test('PERSIST removes the expiry', async () => {
    await node.run('SET', 'k', 'v', 'EX', '1');
    expect(await node.run('PERSIST', 'k')).toBe(1);
    expect(await node.run('PERSIST', 'k')).toBe(0);
    node.clock.advance(2_000n);
    expect(await node.run('GET', 'k')).toBe('v');
  });

  test('EXPIRE with a non-integer or overflowing time', async () => {
    await node.run('SET', 'k', 'v');
    expect(await node.run('EXPIRE', 'k', 'abc')).toEqual({
      error: 'INVALID_ARGUMENT value is not an integer or out of range',
    });
    expect(await node.run('EXPIRE', 'k', '9223372036854775807')).toEqual({
      error: "INVALID_ARGUMENT invalid expire time in 'expire' command",
    });
  });
});

describe('ExpiryJob', () => {
  const job = (n: typeof node) =>
    new ExpiryJob({
      store: n.store,
      rangeId: 1n,
      proposer: n.proposer,
      stamper: new CommandStamper(
        new HybridLogicalClock(n.clock, { maxOffsetMs: 500n }),
        new UlidGenerator(n.clock, new SeededRandom(3n)),
      ),
      clock: n.clock,
      logger: n.logger,
      metrics: n.metrics,
    });

  const indexSize = async () => {
    let count = 0;
    for await (const _ of node.store.iterate(prefixRange(expiryIndexPrefix(1n)))) count++;
    return count;
  };

  test('proposes deletions only for keys that are due', async () => {
    await node.run('SET', 'soon', 'v', 'PX', '100');
    await node.run('SET', 'later', 'v', 'PX', '10000');
    await node.run('SET', 'forever', 'v');
    expect(await indexSize()).toBe(2);
    expect(await job(node).runOnce()).toBe(0);
    node.clock.advance(101n);
    expect(await job(node).runOnce()).toBe(1);
    expect(await indexSize()).toBe(1);
    expect(node.metrics.value('mindlog_kv_expiry_proposed_total')).toBe(1);
    expect(await node.run('GET', 'later')).toBe('v');
  });

  test('a key rewritten after its expiry was scheduled survives', async () => {
    await node.run('SET', 'k', 'v', 'PX', '100');
    await node.run('SET', 'k', 'w');
    node.clock.advance(200n);
    await job(node).runOnce();
    expect(await node.run('GET', 'k')).toBe('w');
    expect(await indexSize()).toBe(0);
  });

  test('start and stop run the job on an interval', async () => {
    await node.run('SET', 'k', 'v', 'PX', '1');
    node.clock.advance(5n);
    const running = job(node);
    running.start(5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await running.stop();
    expect(await indexSize()).toBe(0);
  });
});
