import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'vitest';
import type { Command } from '@mindlog/proto';
import { LevelDbStore, MemoryStore } from '@mindlog/storage';
import { LocalLog, logEntryKey } from '@mindlog/statemachine';
import { writeCommand } from './support/counter-handler.js';

async function collect(log: LocalLog, from: bigint, to?: bigint) {
  const out: [bigint, string][] = [];
  for await (const [i, c] of log.entries(from, to))
    out.push([i, new TextDecoder().decode(c.requestId)]);
  return out;
}

describe('LocalLog', () => {
  test('appends assign consecutive indexes and read back in order', async () => {
    const log = await LocalLog.open(new MemoryStore());
    expect([log.firstIndex, log.lastIndex]).toEqual([1n, 0n]);
    expect(
      await log.append([writeCommand(['INCR', 'a'], 'r1'), writeCommand(['INCR', 'a'], 'r2')]),
    ).toEqual([1n, 2n]);
    expect(await log.append([writeCommand(['INCR', 'a'], 'r3')])).toEqual([3n]);
    expect(await collect(log, 1n)).toEqual([
      [1n, 'r1'],
      [2n, 'r2'],
      [3n, 'r3'],
    ]);
    expect(await collect(log, 2n, 2n)).toEqual([[2n, 'r2']]);
    expect(await collect(log, 4n)).toEqual([]);
  });

  test('reopening finds the first and last index', async () => {
    const store = new MemoryStore();
    const log = await LocalLog.open(store);
    await log.append(Array.from({ length: 5 }, (_, i) => writeCommand(['INCR', 'a'], `r${i}`)));
    await log.compact(2n);
    const reopened = await LocalLog.open(store);
    expect([reopened.firstIndex, reopened.lastIndex]).toEqual([3n, 5n]);
    expect((await collect(reopened, 3n)).map(([i]) => i)).toEqual([3n, 4n, 5n]);
  });

  test('reading compacted entries is an error', async () => {
    const log = await LocalLog.open(new MemoryStore());
    await log.append([writeCommand(['INCR', 'a']), writeCommand(['INCR', 'a'])]);
    await log.compact(1n);
    await expect(collect(log, 1n)).rejects.toThrow(/missing|gap/);
  });

  test('a corrupted entry fails its checksum', async () => {
    const store = new MemoryStore();
    const log = await LocalLog.open(store);
    await log.append([writeCommand(['INCR', 'a'])]);
    const key = logEntryKey(1n, 1n);
    const stored = (await store.get(key)) as Uint8Array;
    stored[stored.length - 1] = (stored[stored.length - 1] ?? 0) ^ 0xff;
    const batch = store.batch();
    batch.put(key, stored);
    await batch.write();
    await expect(collect(log, 1n)).rejects.toThrow(/corrupt/);
  });

  test('synced appends survive reopening the LevelDB log store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'mindlog-log-')), 'raftlog');
    const open = async () => {
      const r = await LevelDbStore.open(path);
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    };
    const store = await open();
    const commands: Command[] = [
      writeCommand(['INCR', 'a'], 'x1'),
      writeCommand(['INCR', 'b'], 'x2'),
    ];
    await (await LocalLog.open(store)).append(commands);
    await store.close();
    const again = await open();
    expect(await collect(await LocalLog.open(again), 1n)).toEqual([
      [1n, 'x1'],
      [2n, 'x2'],
    ]);
    await again.close();
  });
});
