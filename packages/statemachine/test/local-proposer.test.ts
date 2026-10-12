import { describe, expect, test } from 'vitest';
import type { MindlogError, Result } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import type { Proposal } from '@mindlog/statemachine';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import { counterKey, writeCommand } from './support/counter-handler.js';
import { startNode } from './support/node.js';

const text = (v: Uint8Array | undefined) => (v ? new TextDecoder().decode(v) : undefined);
const bulk = (p: Result<Proposal, MindlogError>) =>
  p.ok && p.value.result.outcome.case === 'kv' && p.value.result.outcome.value.kind.case === 'bulk'
    ? text(p.value.result.outcome.value.kind.value)
    : undefined;

describe('LocalProposer', () => {
  test('concurrent proposals get consecutive indexes and their own results', async () => {
    const { proposer, stateStore } = await startNode();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => proposer.propose(writeCommand(['INCR', 'n']))),
    );
    expect(results.map((r) => (r.ok ? r.value.index : -1n))).toEqual(
      Array.from({ length: 20 }, (_, i) => BigInt(i + 1)),
    );
    expect(results.map(bulk)).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1)));
    expect(text(await new MvccReader(stateStore).get(counterKey('n')))).toBe('20');
  });

  test('proposals in the same turn share one log append (group commit)', async () => {
    const { proposer, metrics } = await startNode();
    await Promise.all(
      Array.from({ length: 50 }, () => proposer.propose(writeCommand(['INCR', 'g']))),
    );
    expect(metrics.observations('mindlog_statemachine_group_commit_entries')).toEqual([50]);
  });

  test('group size is capped by maxBatch', async () => {
    const { proposer, metrics } = await startNode(undefined, undefined, { maxBatch: 8 });
    await Promise.all(
      Array.from({ length: 20 }, () => proposer.propose(writeCommand(['INCR', 'g']))),
    );
    expect(metrics.observations('mindlog_statemachine_group_commit_entries')).toEqual([8, 8, 4]);
  });

  test('a full queue rejects with BUSY', async () => {
    const { proposer } = await startNode(undefined, undefined, { maxQueue: 2 });
    const all = await Promise.all(
      [1, 2, 3].map(() => proposer.propose(writeCommand(['INCR', 'b']))),
    );
    expect(all.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual(['ok', 'ok', 'BUSY']);
  });

  test('a storage failure stops the proposer and fails everything pending', async () => {
    const broken: KvStore = Object.assign(new MemoryStore(), {
      batch: () => ({
        put: () => undefined,
        del: () => undefined,
        length: 0,
        write: () => Promise.reject(new Error('disk on fire')),
      }),
    });
    const { proposer, logger } = await startNode(broken);
    const results = await Promise.all(
      [1, 2].map(() => proposer.propose(writeCommand(['INCR', 'x']))),
    );
    expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
      'UNAVAILABLE',
      'UNAVAILABLE',
    ]);
    const later = await proposer.propose(writeCommand(['INCR', 'x']));
    expect(later.ok ? 'ok' : later.error.code).toBe('UNAVAILABLE');
    expect(proposer.failure).toBeInstanceOf(Error);
    expect(logger.entries.some((e) => e.level === 'fatal')).toBe(true);
  });

  test('close waits for pending work and then refuses new proposals', async () => {
    const { proposer } = await startNode();
    const pending = proposer.propose(writeCommand(['INCR', 'c']));
    await proposer.close();
    expect((await pending).ok).toBe(true);
    const after = await proposer.propose(writeCommand(['INCR', 'c']));
    expect(after.ok).toBe(false);
  });
});
