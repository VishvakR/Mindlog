import { describe, expect, test } from 'vitest';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore, MvccReader } from '@mindlog/storage';
import { recover } from '@mindlog/statemachine';
import { counterKey, writeCommand } from './support/counter-handler.js';
import { startNode } from './support/node.js';

const read = async (store: KvStore, name: string) => {
  const value = await new MvccReader(store).get(counterKey(name));
  return value ? new TextDecoder().decode(value) : undefined;
};

describe('recover', () => {
  test('replays entries that reached the log but were never applied', async () => {
    const logStore = new MemoryStore();
    const first = await startNode(logStore);
    await first.proposer.propose(writeCommand(['INCR', 'n']));
    await first.log.append([writeCommand(['INCR', 'n']), writeCommand(['INCR', 'n'])]);

    const restarted = await startNode(logStore, first.stateStore);
    expect(restarted.machine.appliedIndex).toBe(1n);
    expect(await recover(restarted.log, restarted.machine)).toBe(2);
    expect(await read(first.stateStore, 'n')).toBe('3');
    expect(restarted.machine.appliedIndex).toBe(3n);
  });

  test('rebuilds state from scratch when unsynced state was lost entirely', async () => {
    const logStore = new MemoryStore();
    const first = await startNode(logStore);
    for (let i = 0; i < 5; i++) await first.proposer.propose(writeCommand(['INCR', 'n']));
    const fresh = new MemoryStore();
    const restarted = await startNode(logStore, fresh);
    expect(await recover(restarted.log, restarted.machine)).toBe(5);
    expect(await read(fresh, 'n')).toBe('5');
  });

  test('state ahead of the log is corruption', async () => {
    const node = await startNode();
    for (let i = 0; i < 2; i++) await node.proposer.propose(writeCommand(['INCR', 'n']));
    const restarted = await startNode(new MemoryStore(), node.stateStore);
    await expect(recover(restarted.log, restarted.machine)).rejects.toThrow(/ahead of the log/);
  });

  test('checkpoints flush state, then compact the log up to it', async () => {
    const node = await startNode(undefined, undefined, { checkpointEvery: 3 });
    for (let i = 0; i < 7; i++) await node.proposer.propose(writeCommand(['INCR', 'n']));
    expect(node.log.firstIndex).toBe(7n);
    expect(node.log.lastIndex).toBe(7n);
    const restarted = await startNode(node.logStore, node.stateStore);
    expect(await recover(restarted.log, restarted.machine)).toBe(0);
    expect(await read(node.stateStore, 'n')).toBe('7');
  });

  test('restart after compacting every entry replays nothing and continues the index', async () => {
    const node = await startNode();
    for (let i = 0; i < 3; i++) await node.proposer.propose(writeCommand(['INCR', 'n']));
    await node.proposer.checkpoint();
    expect([node.log.firstIndex, node.log.lastIndex]).toEqual([4n, 3n]);
    const restarted = await startNode(node.logStore, node.stateStore);
    expect(await recover(restarted.log, restarted.machine)).toBe(0);
    const next = await restarted.proposer.propose(writeCommand(['INCR', 'n']));
    expect(next.ok && next.value.index).toBe(4n);
    expect(await read(node.stateStore, 'n')).toBe('4');
  });

  test('missing entries below the log start are detected', async () => {
    const node = await startNode(undefined, undefined, { checkpointEvery: 2 });
    for (let i = 0; i < 4; i++) await node.proposer.propose(writeCommand(['INCR', 'n']));
    await node.log.append([writeCommand(['INCR', 'n'])]);
    const restarted = await startNode(node.logStore, new MemoryStore());
    await expect(recover(restarted.log, restarted.machine)).rejects.toThrow(/compacted/);
  });
});
