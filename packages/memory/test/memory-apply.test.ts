import { create, fromBinary } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import { decodeCount, decodeStats } from '@mindlog/index-text';
import {
  dfKey,
  entityKey,
  generationKey,
  mentionKey,
  postingKey,
  recordKey,
  statsKey,
  vectorKey,
} from '@mindlog/memory';
import type { NewMemory } from '@mindlog/proto';
import { MemoryEntitySchema, MemoryRecordSchema, NewMemorySchema } from '@mindlog/proto';
import { entryKey } from '@mindlog/cache';
import { MvccReader } from '@mindlog/storage';
import { TENANT, memoryNode } from './support/memory-node.js';

function memory(
  id: string,
  text: string,
  terms: Record<string, number>,
  mentions: string[] = [],
): NewMemory {
  const length = Object.values(terms).reduce((a, b) => a + b, 0);
  return create(NewMemorySchema, {
    record: {
      id,
      user: 'u1',
      kind: 'semantic',
      text,
      trust: 'normal',
      importance: 0.5,
      strength: 1,
      source: { type: 'user', principal: 'p' },
      terms: Object.entries(terms).map(([term, count]) => ({ term, count })),
      termLength: length,
      embeddingModel: 'fake@1',
    },
    vector: new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer),
    mentions: mentions.map((name) => ({ name, type: 'person' })),
  });
}

describe('memory apply', () => {
  test('a commit writes the record and its indexes in one batch', async () => {
    const n = await memoryNode();
    const result = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [
            memory('m1', 'Ana likes tea', { ana: 1, like: 1, tea: 1 }, ['Ana']),
            memory('m2', 'tea tea', { tea: 2 }, ['ana ']),
          ],
          edges: [
            {
              srcName: 'Ana',
              srcType: 'person',
              relation: 'likes',
              dstName: 'tea',
              dstType: 'product',
              memoryId: 'm1',
              weight: 1,
            },
          ],
          enqueue: [],
        },
      }),
    );
    expect(result.outcome).toMatchObject({
      case: 'memory',
      value: { ids: ['m1', 'm2'], count: 2 },
    });
    const r = new MvccReader(n.store);
    const rec = fromBinary(
      MemoryRecordSchema,
      (await r.get(recordKey(TENANT, 'u1', 'm1'))) ?? new Uint8Array(),
    );
    expect(rec.entities).toEqual(['person:ana']);
    expect(rec.createdAt).toBeGreaterThan(0n);
    expect(rec.logIndex).toBeGreaterThan(0n);
    expect(decodeStats(await r.get(statsKey(TENANT, 'u1')))).toEqual({ docs: 2, totalLength: 5 });
    expect(decodeCount(await r.get(dfKey(TENANT, 'u1', 'tea')))).toBe(2);
    expect(await r.get(postingKey(TENANT, 'u1', 'tea', 'm2'))).toBeDefined();
    expect(await r.get(vectorKey(TENANT, 'u1', 'm1'))).toBeDefined();
    const ana = fromBinary(
      MemoryEntitySchema,
      (await r.get(entityKey(TENANT, 'u1', 'person:ana'))) ?? new Uint8Array(),
    );
    expect(ana).toMatchObject({ name: 'Ana', type: 'person', mentionCount: 2 });
    expect(await r.get(mentionKey(TENANT, 'u1', 'person:ana', 'm2'))).toBeDefined();
    expect(decodeCount(await r.get(generationKey(TENANT, 'u1')))).toBe(1);
  });

  test('forget keeps the record, expires it and removes it from every index', async () => {
    const n = await memoryNode();
    await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [
            memory('m1', 'Ana likes tea', { ana: 1, tea: 1 }, ['Ana']),
            memory('m2', 'tea', { tea: 1 }),
          ],
          edges: [],
          enqueue: [],
        },
      }),
    );
    const forgot = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryForget',
        value: { user: 'u1', ids: ['m1', 'nope'], reason: 'user asked' },
      }),
    );
    expect(forgot.outcome).toMatchObject({ case: 'memory', value: { ids: ['m1'], count: 1 } });
    const r = new MvccReader(n.store);
    const rec = fromBinary(
      MemoryRecordSchema,
      (await r.get(recordKey(TENANT, 'u1', 'm1'))) ?? new Uint8Array(),
    );
    expect(rec.expiredAt).toBeGreaterThan(0n);
    expect(rec.forgetReason).toBe('user asked');
    expect(await r.get(vectorKey(TENANT, 'u1', 'm1'))).toBeUndefined();
    expect(await r.get(postingKey(TENANT, 'u1', 'ana', 'm1'))).toBeUndefined();
    expect(await r.get(dfKey(TENANT, 'u1', 'ana'))).toBeUndefined();
    expect(decodeCount(await r.get(dfKey(TENANT, 'u1', 'tea')))).toBe(1);
    expect(decodeStats(await r.get(statsKey(TENANT, 'u1')))).toEqual({ docs: 1, totalLength: 1 });
    expect(await r.get(mentionKey(TENANT, 'u1', 'person:ana', 'm1'))).toBeUndefined();
    expect(await r.get(entityKey(TENANT, 'u1', 'person:ana'))).toBeDefined();
    // Forgetting again changes nothing.
    const again = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryForget',
        value: { user: 'u1', ids: ['m1'], reason: '' },
      }),
    );
    expect(again.outcome).toMatchObject({ case: 'memory', value: { count: 0 } });
  });

  test('invalid commits are results, not failures', async () => {
    const n = await memoryNode();
    const bad = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [
            create(NewMemorySchema, {
              record: { id: 'm1', user: 'u2', kind: 'semantic', text: 'x' },
            }),
          ],
          edges: [],
          enqueue: [],
        },
      }),
    );
    expect(bad.outcome.case === 'error' && bad.outcome.value.code).toBe('INVALID_ARGUMENT');
    const kind = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [
            create(NewMemorySchema, {
              record: { id: 'm1', user: 'u1', kind: 'gossip', text: 'x' },
            }),
          ],
          edges: [],
          enqueue: [],
        },
      }),
    );
    expect(kind.outcome.case === 'error' && kind.outcome.value.code).toBe('INVALID_ARGUMENT');
    expect(await new MvccReader(n.store).get(recordKey(TENANT, 'u1', 'm1'))).toBeUndefined();
  });

  test('two replicas applying the same commands hold identical state', async () => {
    const a = await memoryNode();
    const b = await memoryNode();
    const commands = [
      a.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [memory('m1', 'Ana likes tea', { ana: 1, tea: 1 }, ['Ana'])],
          edges: [],
          enqueue: [{ id: 'j1', kind: 'memory.enrich', payload: new Uint8Array(), runAtMs: 0n }],
        },
      }),
      a.stamper.stamp(TENANT, 'p', {
        case: 'memoryForget',
        value: { user: 'u1', ids: ['m1'], reason: 'r' },
      }),
    ];
    for (const c of commands) {
      await a.propose(c);
      await b.propose(c);
    }
    const [da, db] = [await a.dump(), await b.dump()];
    expect(da).toEqual(db);
    expect(da.length).toBeGreaterThan(5);
  });

  test('forgetting a memory drops the cache entries that depend on it, in the same command', async () => {
    const n = await memoryNode();
    await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryCommit',
        value: {
          user: 'u1',
          memories: [
            memory('m1', 'Ana likes tea', { ana: 1, tea: 1 }),
            memory('m2', 'Bob likes jazz', { bob: 1, jazz: 1 }),
          ],
          edges: [],
          enqueue: [],
        },
      }),
    );
    const set = (id: string, deps: string[]) =>
      n.stamper.stamp(TENANT, 'p', {
        case: 'cacheSet',
        value: {
          user: 'u1',
          entry: { id, prompt: `prompt ${id}`, answer: 'a', memoryDeps: deps },
          maxEntries: 10,
        },
      });
    await n.propose(set('c1', ['m1']));
    await n.propose(set('c2', ['m1', 'm2']));
    await n.propose(set('c3', ['m2']));
    const mvcc = new MvccReader(n.store);
    const present = async () => {
      const out: string[] = [];
      for (const id of ['c1', 'c2', 'c3'])
        if (await mvcc.get(entryKey(TENANT, 'u1', id))) out.push(id);
      return out;
    };
    expect(await present()).toEqual(['c1', 'c2', 'c3']);
    const forgot = await n.propose(
      n.stamper.stamp(TENANT, 'p', {
        case: 'memoryForget',
        value: { user: 'u1', ids: ['m1'], reason: 'r' },
      }),
    );
    expect(forgot.outcome.case === 'memory' && forgot.outcome.value.ids).toEqual(['m1']);
    expect(await present()).toEqual(['c3']);
    // An entry naming a forgotten or unknown memory is refused, whatever the order in the log.
    for (const deps of [['m1'], ['nope']]) {
      const late = await n.propose(set(`late-${deps[0] ?? ''}`, deps));
      expect(late.outcome.case === 'error' && late.outcome.value.code).toBe('NOT_FOUND');
    }
  });
});
