import { describe, expect, test } from 'vitest';
import { MemoryLogger } from '@mindlog/core';
import { LockResolverJob } from '@mindlog/txn';
import { b, ts, txnNode } from './support/txn-node.js';

describe('LockResolverJob', () => {
  test('resolves only locks past their TTL, and only while active', async () => {
    const n = await txnNode();
    await n.propose({
      case: 'txnPrewrite',
      value: {
        startTs: ts(10),
        primary: b('a'),
        ttlMs: 1000n,
        writes: [{ argv: ['SET', 'a', '1'].map(b) }],
      },
    });
    const resolved: string[] = [];
    let active = false;
    const job = new LockResolverJob({
      state: n.store,
      rangeId: 1n,
      active: () => active,
      clock: n.clock,
      logger: new MemoryLogger(),
      resolve: (held) => {
        resolved.push(new TextDecoder().decode(held.key));
        return Promise.resolve();
      },
    });
    expect(await job.runOnce()).toBe(0);
    active = true;
    expect(await job.runOnce()).toBe(0); // still within its TTL
    n.clock.advance(5000n);
    expect(await job.runOnce()).toBe(1);
    expect(resolved).toEqual(['a']);
  });
});
