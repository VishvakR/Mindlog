import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import { EntrySchema, EntryType, HardStateSchema } from '@mindlog/proto';
import type { KvStore } from '@mindlog/storage';
import { LevelDbStore, MemoryStore } from '@mindlog/storage';
import { RaftLogStore, STORE_FORMAT, ensureStoreFormat } from '@mindlog/statemachine';
import { describe, expect, test } from 'vitest';

const entry = (index: bigint, term: bigint, data = `e${index}`) =>
  create(EntrySchema, {
    index,
    term,
    type: EntryType.NORMAL,
    data: new TextEncoder().encode(data),
  });

/** Shared contract for the log store over any KvStore. */
function describeRaftLogStoreContract(
  name: string,
  open: () => Promise<{ store: KvStore; close: () => Promise<void> }>,
) {
  describe(`RaftLogStore over ${name}`, () => {
    test('round-trips entries and hard state', async () => {
      const { store, close } = await open();
      const log = new RaftLogStore(store);
      await log.load();
      await log.persist({
        hardState: create(HardStateSchema, { term: 2n, vote: 1n, commit: 2n }),
        entries: [entry(1n, 1n), entry(2n, 2n)],
        sync: true,
      });
      const loaded = await new RaftLogStore(store).load();
      expect(loaded.hardState).toMatchObject({ term: 2n, vote: 1n, commit: 2n });
      expect(loaded.entries.map((e) => [e.index, e.term])).toEqual([
        [1n, 1n],
        [2n, 2n],
      ]);
      await close();
    });

    test('a new append replaces the conflicting suffix', async () => {
      const { store, close } = await open();
      const log = new RaftLogStore(store);
      await log.load();
      await log.persist({ entries: [entry(1n, 1n), entry(2n, 1n), entry(3n, 1n)], sync: true });
      await log.persist({ entries: [entry(2n, 2n, 'new')], sync: true });
      const loaded = await new RaftLogStore(store).load();
      expect(loaded.entries.map((e) => [e.index, e.term])).toEqual([
        [1n, 1n],
        [2n, 2n],
      ]);
      await close();
    });

    test('compaction keeps the truncated point; a snapshot replaces the whole log', async () => {
      const { store, close } = await open();
      const log = new RaftLogStore(store);
      await log.load();
      await log.persist({ entries: [entry(1n, 1n), entry(2n, 1n), entry(3n, 2n)], sync: true });
      await log.compact({ index: 2n, term: 1n });
      let loaded = await new RaftLogStore(store).load();
      expect(loaded.truncated).toEqual({ index: 2n, term: 1n });
      expect(loaded.entries.map((e) => e.index)).toEqual([3n]);

      const again = new RaftLogStore(store);
      await again.load();
      await again.persist({ entries: [], snapshot: { index: 10n, term: 3n }, sync: true });
      await again.persist({ entries: [entry(11n, 3n)], sync: true });
      loaded = await new RaftLogStore(store).load();
      expect(loaded.truncated).toEqual({ index: 10n, term: 3n });
      expect(loaded.entries.map((e) => e.index)).toEqual([11n]);
      await close();
    });

    test('a corrupt entry is detected on load', async () => {
      const { store, close } = await open();
      const log = new RaftLogStore(store);
      await log.load();
      await log.persist({ entries: [entry(1n, 1n)], sync: true });
      const [key, value] = await first(store);
      const corrupt = value.slice();
      corrupt[corrupt.length - 1] = (corrupt.at(-1) ?? 0) ^ 0xff;
      const batch = store.batch();
      batch.put(key, corrupt);
      await batch.write();
      await expect(new RaftLogStore(store).load()).rejects.toThrow(/corrupt/);
      await close();
    });
  });
}

async function first(store: KvStore): Promise<readonly [Uint8Array, Uint8Array]> {
  for await (const kv of store.iterate({ start: new Uint8Array(), end: Uint8Array.of(0xff) }))
    return kv;
  throw new Error('empty store');
}

describeRaftLogStoreContract('MemoryStore', () =>
  Promise.resolve({
    store: new MemoryStore(),
    close: async () => {},
  }),
);
describeRaftLogStoreContract('LevelDbStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mindlog-raftlog-'));
  const opened = await LevelDbStore.open(dir);
  if (!opened.ok) throw new Error(opened.error.message);
  return {
    store: opened.value,
    close: async () => {
      await opened.value.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
});

describe('store format markers (ADR-0026)', () => {
  test('stamps an empty store and accepts it again', async () => {
    const store = new MemoryStore();
    expect((await ensureStoreFormat(store, 'log')).ok).toBe(true);
    expect((await ensureStoreFormat(store, 'log')).ok).toBe(true);
  });

  test('refuses a store with data but no marker, or another version', async () => {
    const legacy = new MemoryStore();
    const batch = legacy.batch();
    batch.put(Uint8Array.of(1, 2), Uint8Array.of(3));
    await batch.write();
    const refused = await ensureStoreFormat(legacy, 'state');
    expect(refused.ok ? undefined : refused.error).toMatchObject({ code: 'CONFIG_INVALID' });

    const future = new MemoryStore();
    await ensureStoreFormat(future, 'state');
    const [key] = await first(future);
    const b = future.batch();
    b.put(key, Uint8Array.of(STORE_FORMAT + 1));
    await b.write();
    expect((await ensureStoreFormat(future, 'state')).ok).toBe(false);
  });
});
