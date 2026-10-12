import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { packHlc } from '@mindlog/core';
import type { KvStore } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';
import { recover } from '@mindlog/statemachine';
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

test('replicas applying the same log reach byte-identical state', async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
      const commands = ops.map((o) =>
        writeCommand([o.verb, o.name], o.requestId, packHlc(o.hlc, 0n)),
      );
      const leader = await startNode();
      for (const command of commands) await leader.proposer.propose(command);

      const follower = await startNode();
      for (const [i, command] of commands.entries())
        await follower.machine.apply(BigInt(i + 1), command);

      const rebuilt = await startNode(leader.logStore, new MemoryStore());
      await recover(rebuilt.log, rebuilt.machine);

      const expected = await stateHash(leader.stateStore);
      expect(await stateHash(follower.stateStore)).toBe(expected);
      expect(await stateHash(rebuilt.stateStore)).toBe(expected);
    }),
    { numRuns: 150 },
  );
}, 60_000);
