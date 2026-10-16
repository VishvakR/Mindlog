import { create } from '@bufbuild/protobuf';
import { EntrySchema, EntryType, MessageSchema, MessageType } from '@mindlog/proto';
import { describe, expect, test } from 'vitest';
import { Harness, compact, enc } from './support/harness.js';

const ids = [1n, 2n, 3n];

function elected(options = {}): Harness {
  const h = new Harness(options);
  h.addNodes(ids);
  h.campaign(1n);
  h.stabilize();
  return h;
}

describe('log replication', () => {
  test('proposals commit and apply in order on every node', () => {
    const h = elected();
    for (const v of ['a', 'b', 'c']) h.propose(1n, v);
    h.stabilize();
    for (const id of ids) expect(h.node(id).applied).toEqual(['a', 'b', 'c']);
    h.checkSafety();
  });

  test('a follower forwards proposals to the leader', () => {
    const h = elected();
    h.propose(3n, 'via-follower');
    h.stabilize();
    expect(h.node(1n).applied).toEqual(['via-follower']);
  });

  test('a minority cannot commit', () => {
    const h = elected();
    h.isolate(2n);
    h.isolate(3n);
    h.propose(1n, 'lonely');
    h.stabilize();
    expect(h.node(1n).applied).toEqual([]);
    h.heal();
    h.tickAll(2);
    expect(h.node(2n).applied).toEqual(['lonely']);
  });

  test('a lagging follower catches up with fast backtracking', () => {
    const h = elected();
    h.isolate(3n);
    for (let i = 0; i < 50; i++) h.propose(1n, `v${i}`);
    h.stabilize();
    h.heal();
    h.tickAll(2);
    expect(h.node(3n).applied).toHaveLength(50);
    // Probe → replicate takes few round trips, not one per entry.
    const rejects = h.delivered.filter((m) => m.type === MessageType.APPEND_RESPONSE && m.reject);
    expect(rejects.length).toBeLessThanOrEqual(2);
  });

  test('a follower with conflicting uncommitted entries is overwritten', () => {
    const h = elected();
    // Leader 1 writes entries only it holds, then loses leadership.
    h.isolate(1n);
    h.propose(1n, 'lost-1');
    h.propose(1n, 'lost-2');
    h.stabilize();
    for (let i = 0; i < 30; i++) {
      h.tick(2n);
      h.tick(3n);
      h.stabilize();
    }
    const newLeader = h.leader();
    expect(newLeader === 2n || newLeader === 3n).toBe(true);
    h.propose(newLeader ?? 2n, 'kept');
    h.stabilize();
    h.heal();
    h.tickAll(3);
    for (const id of ids) expect(h.node(id).applied).toEqual(['kept']);
    h.checkSafety();
  });

  test('a leader never commits an entry of an older term by counting (Figure 8)', () => {
    const h = new Harness({ checkQuorum: false, preVote: false, maxEntryBatchBytes: 1 });
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    // Leader 1 (term 2) appends 'old' at index 5 but replicates it nowhere.
    h.isolate(1n);
    h.propose(1n, 'old');
    h.stabilize();
    // Node 1 is re-elected at term 3 with node 3's vote; node 2 stays away.
    h.restart(1n);
    h.heal();
    h.isolate(2n);
    h.campaign(1n);
    const commitsWhileOnlyOldReplicated: bigint[] = [];
    for (let round = 0; round < 50; round++) {
      for (const id of ids) h.processReady(id);
      if (h.deliver() === 0) break;
      const s = h.node(1n).raw.status();
      const p3 = s.progress.find((p) => p.id === 3n);
      if (s.role === 'leader' && p3?.match === 5n) commitsWhileOnlyOldReplicated.push(s.commit);
    }
    expect(commitsWhileOnlyOldReplicated.length).toBeGreaterThan(0);
    // A majority (1 and 3) holds index 5 of term 2, yet it is not committed by counting.
    expect(commitsWhileOnlyOldReplicated.every((c) => c === 4n)).toBe(true);
    // It commits indirectly once the term-3 no-op reaches node 3.
    expect(h.node(1n).raw.status().commit).toBe(6n);
    expect(h.node(1n).applied).toEqual(['old']);
  });

  test('pipelining stops at maxInflightMsgs until acks arrive', () => {
    const h = elected({ maxInflightMsgs: 2, maxEntryBatchBytes: 1 });
    for (let i = 0; i < 10; i++) h.propose(1n, `p${i}`);
    h.processReady(1n);
    const appendsTo2 = h.inbox.filter((m) => m.to === 2n && m.type === MessageType.APPEND);
    expect(appendsTo2).toHaveLength(2);
    h.stabilize();
    expect(h.node(2n).applied).toHaveLength(10);
  });

  test('stale terms are rejected and the stale leader steps down', () => {
    const h = elected();
    h.isolate(1n);
    for (let i = 0; i < 30; i++) {
      h.tick(2n);
      h.tick(3n);
      h.stabilize();
    }
    h.heal();
    // The old leader's heartbeat hits a newer term.
    h.tick(1n);
    h.stabilize();
    expect(h.node(1n).raw.status().role).toBe('follower');
    expect(h.node(1n).raw.status().term).toBeGreaterThan(1n);
  });

  test('a restarted node keeps its term, vote and log', () => {
    const h = elected();
    h.propose(1n, 'x');
    h.stabilize();
    h.restart(2n);
    const s = h.node(2n).raw.status();
    expect(s).toMatchObject({ term: 2n, vote: 1n, lastIndex: 5n, applied: 5n });
  });

  test('messages for another node are ignored', () => {
    const h = elected();
    const before = h.node(2n).raw.status();
    h.node(2n).raw.step(
      create(MessageSchema, { type: MessageType.APPEND, from: 1n, to: 3n, term: 9n }),
    );
    expect(h.node(2n).raw.status().term).toBe(before.term);
  });
});

describe('snapshots', () => {
  test('a follower behind the compacted log receives a snapshot', () => {
    const h = elected();
    h.isolate(3n);
    for (let i = 0; i < 20; i++) h.propose(1n, `s${i}`);
    h.stabilize();
    compact(h, 1n);
    h.heal();
    h.tickAll(3);
    const n3 = h.node(3n);
    expect(n3.applied).toEqual(h.node(1n).applied);
    expect(n3.truncated.index).toBe(h.node(1n).appliedIndex);
    expect(h.delivered.some((m) => m.type === MessageType.SNAPSHOT && m.to === 3n)).toBe(true);
    h.propose(1n, 'after');
    h.stabilize();
    expect(n3.applied.at(-1)).toBe('after');
  });

  test('a snapshot the follower already covers only fast-forwards commit', () => {
    const h = elected();
    h.propose(1n, 'a');
    h.processReady(1n);
    // Node 2 receives entry 5 but not yet the commit that covers it.
    h.deliver((m) => m.to === 2n && m.type === MessageType.APPEND);
    const n2 = h.node(2n);
    h.processReady(2n);
    expect(n2.raw.status()).toMatchObject({ lastIndex: 5n, commit: 4n });
    n2.raw.step(
      create(MessageSchema, {
        type: MessageType.SNAPSHOT,
        from: 1n,
        to: 2n,
        term: 2n,
        snapshot: { index: 5n, term: 2n, confState: { voters: ids } },
      }),
    );
    const rd = n2.raw.ready();
    expect(rd.snapshot).toBeUndefined();
    expect(rd.committedEntries.map((e) => e.index)).toEqual([5n]);
    n2.raw.advance(rd);
  });

  test('compacted entries are not available for slicing', () => {
    const h = elected();
    h.propose(1n, 'a');
    h.stabilize();
    compact(h, 1n);
    expect(h.node(1n).raw.termAt(0n)).toBeUndefined();
    expect(h.node(1n).raw.status().firstIndex).toBe(6n);
  });
});

describe('RaftLog edge cases', () => {
  test('appending over committed entries is a programmer error', () => {
    const h = elected();
    h.propose(1n, 'a');
    h.stabilize();
    const n2 = h.node(2n);
    // A (buggy) leader of the same term claiming a different entry at a committed index.
    n2.raw.step(
      create(MessageSchema, {
        type: MessageType.APPEND,
        from: 1n,
        to: 2n,
        term: 1n,
        index: 0n,
        logTerm: 0n,
        entries: [
          create(EntrySchema, { term: 2n, index: 1n, type: EntryType.NORMAL, data: enc('z') }),
        ],
        commit: 0n,
      }),
    );
    // index 0 < committed 2: answered with the commit index, nothing overwritten.
    expect(h.node(2n).raw.status().lastIndex).toBe(5n);
  });
});
