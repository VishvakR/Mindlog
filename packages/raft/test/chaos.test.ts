import { SeededRandom } from '@mindlog/core';
import { describe, expect, test } from 'vitest';
import { Harness, compact } from './support/harness.js';

/**
 * Randomized faults at the core level: random partitions, drops, reorders,
 * restarts and compactions. Checks election safety (one leader per term) and
 * state machine safety (applied logs are prefixes of each other) after every
 * step, and that the cluster makes progress once healed.
 */
function run(seed: bigint): void {
  const rnd = new SeededRandom(seed);
  const h = new Harness({ seed });
  const ids = [1n, 2n, 3n, 4n, 5n];
  h.addNodes(ids);
  const leaders = new Map<bigint, bigint>();
  let proposals = 0;
  const pick = (): bigint => ids[Math.floor(rnd.next() * ids.length)] ?? 1n;

  const checkLeaders = (): void => {
    for (const id of ids) {
      const s = h.node(id).raw.status();
      if (s.role !== 'leader') continue;
      const known = leaders.get(s.term);
      if (known !== undefined && known !== id)
        throw new Error(`seed ${seed}: two leaders in term ${s.term}`);
      leaders.set(s.term, id);
    }
  };

  for (let step = 0; step < 400; step++) {
    const roll = rnd.next();
    if (roll < 0.03) h.isolate(pick());
    else if (roll < 0.06) h.heal();
    else if (roll < 0.08) h.restart(pick());
    else if (roll < 0.09) {
      const id = pick();
      // The host compacts only between Readies.
      if (!h.node(id).raw.hasReady() && h.node(id).appliedIndex > h.node(id).truncated.index)
        compact(h, id);
    } else if (roll < 0.3) {
      const id = pick();
      if (h.node(id).raw.propose(new TextEncoder().encode(`s${seed}-${proposals}`)).ok) proposals++;
    }
    for (const id of ids) if (rnd.next() < 0.5) h.node(id).raw.tick();
    for (const id of ids) h.processReady(id);
    // Deliver a random subset, in shuffled order; the rest wait (reordering).
    const batch = h.inbox;
    h.inbox = [];
    for (const m of batch) {
      const r = rnd.next();
      if (r < 0.1) continue; // dropped
      if (r < 0.25)
        h.inbox.push(m); // delayed
      else if (!h.cut.has(`${m.from}>${m.to}`)) h.nodes.get(m.to)?.raw.step(m);
    }
    checkLeaders();
    h.checkSafety();
  }

  h.heal();
  const before = Math.max(...ids.map((id) => h.node(id).applied.length));
  for (let i = 0; i < 60 && h.leader() === undefined; i++) h.tickAll(1);
  const leader = h.leader();
  expect(leader, `seed ${seed}: no leader after healing`).toBeDefined();
  h.propose(leader ?? 1n, 'final');
  const done = (): boolean => ids.every((id) => h.node(id).applied.includes('final'));
  // Liveness bound: a stuck snapshot is retried after 2 × electionTicks.max. A
  // proposal may be lost when leadership changes, so retry it like a client.
  for (let i = 0; i < 150 && !done(); i++) {
    const current = h.leader();
    if (i % 25 === 24 && current !== undefined)
      h.node(current).raw.propose(new TextEncoder().encode('final'));
    h.tickAll(1);
  }
  h.checkSafety();
  for (const id of ids) {
    expect(
      h.node(id).applied.includes('final'),
      `seed ${seed}: node ${id} missed the final write`,
    ).toBe(true);
    expect(h.node(id).applied.length).toBeGreaterThan(before);
  }
}

describe('core under random faults', () => {
  test(
    'seeds keep election and state machine safety (RAFT_SEEDS, default 200)',
    { timeout: 600_000 },
    () => {
      const from = BigInt(process.env.RAFT_SEED ?? 1);
      const to = BigInt(process.env.RAFT_SEED ?? process.env.RAFT_SEEDS ?? 200);
      for (let seed = from; seed <= to; seed++) {
        try {
          run(seed);
        } catch (cause) {
          throw new Error(
            `seed ${seed}: ${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
      }
    },
  );
});
