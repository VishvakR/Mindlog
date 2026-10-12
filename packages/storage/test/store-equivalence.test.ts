import { join } from 'node:path';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { KvStore } from '@mindlog/storage';
import { LevelDbStore, MemoryStore } from '@mindlog/storage';
import { tempDir } from './temp-dir.js';

const key = fc.uint8Array({ minLength: 0, maxLength: 4, max: 4 });
const op = fc.oneof(
  fc.record({ kind: fc.constant('put' as const), key, value: fc.uint8Array({ maxLength: 3 }) }),
  fc.record({ kind: fc.constant('del' as const), key }),
);
const batches = fc.array(fc.array(op, { minLength: 1, maxLength: 6 }), { maxLength: 8 });
const query = fc.record({
  start: key,
  end: key,
  reverse: fc.boolean(),
  limit: fc.option(fc.integer({ min: 0, max: 5 }), { nil: undefined }),
});

type Query = typeof query extends fc.Arbitrary<infer Q> ? Q : never;

async function dump(store: KvStore, q: Query): Promise<string> {
  const out: string[] = [];
  const options =
    q.limit === undefined ? { reverse: q.reverse } : { reverse: q.reverse, limit: q.limit };
  for await (const [k, v] of store.iterate({ start: q.start, end: q.end }, options)) {
    out.push(`${k.join('.')}=${v.join('.')}`);
  }
  return out.join(' ');
}

test('MemoryStore and LevelDbStore agree on random operation sequences', async () => {
  let run = 0;
  await fc.assert(
    fc.asyncProperty(batches, fc.array(query, { minLength: 1, maxLength: 4 }), async (bs, qs) => {
      const opened = await LevelDbStore.open(join(tempDir(), `db-${run++}`));
      if (!opened.ok) throw new Error(opened.error.message);
      const stores = [new MemoryStore(), opened.value];
      for (const ops of bs) {
        for (const store of stores) {
          const batch = store.batch();
          for (const o of ops) {
            if (o.kind === 'put') batch.put(o.key, o.value);
            else batch.del(o.key);
          }
          await batch.write();
        }
      }
      for (const q of qs) {
        const [memory, level] = await Promise.all(stores.map((s) => dump(s, q)));
        expect(level).toBe(memory);
      }
      await Promise.all(stores.map((s) => s.close()));
    }),
    { numRuns: 60 },
  );
}, 60_000);
