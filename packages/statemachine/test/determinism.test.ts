import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { packHlc } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';
import { writeCommand } from './support/counter-handler.js';
import { startNode } from './support/node.js';

/** Hash of every raw key and value: two replicas agree iff the hashes match. */
async function stateHash(store: KvStore): Promise<string> {
  const hash = createHash('sha256');
  for await (const [key, value] of store.iterate({
    start: new Uint8Array(),
    end: Uint8Array.of(0xff),
  })) {
    hash.update(key).update(Uint8Array.of(0)).update(value).update(Uint8Array.of(0));
  }
  return hash.digest('hex');
}

const op = fc.record({
  verb: fc.constantFrom('INCR', 'ROLL', 'STAMP', 'BOGUS'),
  name: fc.constantFrom('a', 'b', 'c'),
  hlc: fc.bigInt({ min: 0n, max: 2n ** 48n - 1n }),
  requestId: fc.constantFrom('r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'),
});

test('replicas applying the same log, or installing a snapshot of it, reach identical state', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
      const commands = ops.map((o) =>
        writeCommand([o.verb, o.name], o.requestId, packHlc(o.hlc, 0n)),
      );
      const leader = await startNode();
      const follower = await startNode();
      for (const [i, command] of commands.entries()) {
        await leader.machine.apply(BigInt(i + 1), 1n, command);
        await follower.machine.apply(BigInt(i + 1), 1n, command);
      }

      const rebuilt = await startNode(new MemoryStore());
      const snapshot = await leader.machine.snapshot();
      const pairs = [];
      for await (const chunk of snapshot.chunks(64)) pairs.push(...chunk);
      await snapshot.release();
      await rebuilt.machine.installSnapshot(snapshot.meta, pairs);
      expect(rebuilt.machine.applied).toEqual({
        index: BigInt(commands.length),
        term: commands.length ? 1n : 0n,
      });

      const expected = await stateHash(leader.stateStore);
      expect(await stateHash(follower.stateStore)).toBe(expected);
      expect(await stateHash(rebuilt.stateStore)).toBe(expected);
    }),
    { numRuns: 150 },
  );
}, 60_000);
