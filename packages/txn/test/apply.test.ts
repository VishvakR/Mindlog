import { describe, expect, test } from 'vitest';
import type { CommandResult } from '@mindlog/proto';
import { TxnStatus } from '@mindlog/proto';
import { headerKey } from '@mindlog/kv';
import { snapshotRead } from '@mindlog/txn';
import { b, ts, txnNode } from './support/txn-node.js';

const status = (r: CommandResult): TxnStatus =>
  r.outcome.case === 'txn' ? r.outcome.value.status : TxnStatus.UNSPECIFIED;
const prewrite = (startTs: bigint, key: string, argv: string[], ttlMs = 3000n) => ({
  case: 'txnPrewrite' as const,
  value: { startTs, primary: b(key), ttlMs, writes: [{ argv: argv.map(b) }] },
});
const commit = (startTs: bigint, commitTs: bigint, key: string) => ({
  case: 'txnCommit' as const,
  value: { startTs, commitTs, keys: [b(key)], primary: b(key) },
});

describe('transaction apply', () => {
  test('a committed write lands at the commit timestamp and leaves no lock', async () => {
    const n = await txnNode();
    expect(status(await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1'])))).toBe(TxnStatus.OK);
    // Nothing is visible before the commit.
    expect(await n.reader.get(headerKey('default', b('a')))).toBeUndefined();
    const done = await n.propose(commit(ts(10), ts(20), 'a'));
    expect(status(done)).toBe(TxnStatus.OK);
    const header = await n.reader.getVersioned(headerKey('default', b('a')));
    expect(header?.index).toBe(ts(20));
    // The lock is gone, so a plain write goes through.
    expect(
      (await n.propose({ case: 'kvWrite', value: { argv: ['SET', 'a', '2'].map(b) } })).outcome
        .case,
    ).toBe('kv');
  });

  test('committing twice is harmless', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['INCR', 'a']));
    await n.propose(commit(ts(10), ts(20), 'a'));
    expect(status(await n.propose(commit(ts(10), ts(20), 'a')))).toBe(TxnStatus.OK);
    const again = await n.propose({ case: 'kvWrite', value: { argv: ['GET', 'a'].map(b) } });
    expect(again.outcome.case === 'kv' && again.outcome.value.kind.case).toBe('bulk');
  });

  test('another transaction meets the lock; a newer committed version conflicts', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1']));
    const blocked = await n.propose(prewrite(ts(11), 'a', ['SET', 'a', '2']));
    expect(status(blocked)).toBe(TxnStatus.LOCKED);
    await n.propose(commit(ts(10), ts(20), 'a'));
    // A transaction that started before that commit must not overwrite it.
    expect(status(await n.propose(prewrite(ts(15), 'a', ['SET', 'a', '3'])))).toBe(
      TxnStatus.CONFLICT,
    );
    expect(status(await n.propose(prewrite(ts(25), 'a', ['SET', 'a', '3'])))).toBe(TxnStatus.OK);
  });

  test('a plain write to a locked key is refused and not applied', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1']));
    const plain = await n.propose({ case: 'kvWrite', value: { argv: ['SET', 'a', 'x'].map(b) } });
    expect(plain.outcome.case).toBe('error');
  });

  test('checking an expired lock rolls the transaction back and fences late arrivals', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1'], 100n));
    n.clock.advance(1000n);
    const checked = await n.propose({
      case: 'txnCheck',
      value: { startTs: ts(10), primary: b('a') },
    });
    expect(status(checked)).toBe(TxnStatus.ROLLED_BACK);
    expect(status(await n.propose(commit(ts(10), ts(20), 'a')))).toBe(TxnStatus.ABORTED);
    expect(status(await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1'])))).toBe(
      TxnStatus.CONFLICT,
    );
  });

  test('checking a live lock reports it; checking a committed transaction reports its timestamp', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1'], 60_000n));
    const live = await n.propose({ case: 'txnCheck', value: { startTs: ts(10), primary: b('a') } });
    expect(status(live)).toBe(TxnStatus.LOCKED);
    await n.propose(commit(ts(10), ts(20), 'a'));
    const done = await n.propose({ case: 'txnCheck', value: { startTs: ts(10), primary: b('a') } });
    expect(status(done)).toBe(TxnStatus.COMMITTED);
    expect(done.outcome.case === 'txn' && done.outcome.value.commitTs).toBe(ts(20));
  });

  test('rollback releases the lock and blocks a later commit', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1']));
    await n.propose({ case: 'txnRollback', value: { startTs: ts(10), keys: [b('a')] } });
    expect(status(await n.propose(commit(ts(10), ts(20), 'a')))).toBe(TxnStatus.ABORTED);
    expect(
      (await n.propose({ case: 'kvWrite', value: { argv: ['SET', 'a', '9'].map(b) } })).outcome
        .case,
    ).toBe('kv');
  });
});

describe('snapshot reads', () => {
  test('a read sees the newest version at or below its timestamp, not later ones', async () => {
    const n = await txnNode();
    for (const [start, commitTs, value] of [
      [10, 20, '1'],
      [30, 40, '2'],
    ] as const) {
      await n.propose(prewrite(ts(start), 'a', ['SET', 'a', value]));
      await n.propose(commit(ts(start), ts(commitTs), 'a'));
    }
    const d = {
      registry: n.registry,
      state: n.store,
      descriptor: n.replica.descriptor,
      tenant: 'default',
    };
    const at = async (when: number) => {
      const r = await snapshotRead(d, [b('GET'), b('a')], ts(when));
      const reply = r.ok ? r.value.replies[0] : undefined;
      return reply?.kind.case === 'bulk' ? new TextDecoder().decode(reply.kind.value) : null;
    };
    expect(await at(15)).toBeNull();
    expect(await at(25)).toBe('1');
    expect(await at(45)).toBe('2');
  });

  test('a read at or after a lock that started before it meets the lock', async () => {
    const n = await txnNode();
    await n.propose(prewrite(ts(10), 'a', ['SET', 'a', '1']));
    const d = {
      registry: n.registry,
      state: n.store,
      descriptor: n.replica.descriptor,
      tenant: 'default',
    };
    const locked = await snapshotRead(d, [b('GET'), b('a')], ts(15));
    expect(locked.ok && locked.value.status).toBe(TxnStatus.LOCKED);
    const before = await snapshotRead(d, [b('GET'), b('a')], ts(5));
    expect(before.ok && before.value.status).toBe(TxnStatus.OK);
  });
});

describe('snapshot reads of counters', () => {
  test('a read between two commits sees the value after the first, whatever came before', async () => {
    const n = await txnNode();
    const steps = [
      [10, 20, ['SET', 'a', '100']],
      [30, 40, ['INCRBY', 'a', '5']],
      [50, 60, ['DECRBY', 'a', '3']],
      [70, 80, ['INCRBY', 'a', '2']],
    ] as const;
    for (const [start, commitTs, argv] of steps) {
      await n.propose(prewrite(ts(start), 'a', [...argv]));
      await n.propose(commit(ts(start), ts(commitTs), 'a'));
    }
    const d = {
      registry: n.registry,
      state: n.store,
      descriptor: n.replica.descriptor,
      tenant: 'default',
    };
    const at = async (when: number) => {
      const r = await snapshotRead(d, [b('GET'), b('a')], ts(when));
      const reply = r.ok ? r.value.replies[0] : undefined;
      return reply?.kind.case === 'bulk' ? new TextDecoder().decode(reply.kind.value) : null;
    };
    expect(await at(25)).toBe('100');
    expect(await at(45)).toBe('105');
    expect(await at(65)).toBe('102');
    expect(await at(85)).toBe('104');
  });
});

describe('snapshot reads after a split', () => {
  test('a key outside the range the reader was given is RANGE_MOVED, not "no such key"', async () => {
    const n = await txnNode();
    const narrowed = {
      ...n.replica.descriptor,
      endKey: headerKey('default', b('m')),
    };
    const d = { registry: n.registry, state: n.store, descriptor: narrowed, tenant: 'default' };
    const r = await snapshotRead(d, [b('GET'), b('zebra')], ts(5));
    expect(!r.ok && r.error.code).toBe('RANGE_MOVED');
  });
});
