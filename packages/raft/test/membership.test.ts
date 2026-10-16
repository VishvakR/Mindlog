import { ConfChangeType, MessageType } from '@mindlog/proto';
import { describe, expect, test } from 'vitest';
import { Harness } from './support/harness.js';

const ids = [1n, 2n, 3n];

function elected(): Harness {
  const h = new Harness();
  h.addNodes(ids);
  h.campaign(1n);
  h.stabilize();
  return h;
}

describe('membership changes (ADR-0006)', () => {
  test('add a learner, let it catch up, then promote it', () => {
    const h = elected();
    for (let i = 0; i < 5; i++) h.propose(1n, `v${i}`);
    h.stabilize();
    h.addEmptyNode(4n);
    h.proposeConfChange(1n, { type: ConfChangeType.ADD_LEARNER, nodeId: 4n, address: 'n4:7000' });
    h.stabilize();
    h.tickAll(2);
    const n4 = h.node(4n);
    expect(n4.applied).toEqual(h.node(1n).applied);
    expect(n4.raw.status().confState).toMatchObject({ voters: ids, learners: [4n] });
    expect(n4.raw.status().confState.addresses['4']).toBe('n4:7000');
    // A learner never campaigns.
    h.tick(4n, 50);
    expect(n4.raw.status().role).toBe('follower');

    h.proposeConfChange(1n, { type: ConfChangeType.ADD_VOTER, nodeId: 4n, address: '' });
    h.stabilize();
    expect(h.node(1n).raw.status().confState).toMatchObject({
      voters: [1n, 2n, 3n, 4n],
      learners: [],
    });
    h.propose(1n, 'with-four');
    h.stabilize();
    expect(n4.applied.at(-1)).toBe('with-four');
  });

  test('only one change may be in flight', () => {
    const h = elected();
    h.addEmptyNode(4n);
    h.addEmptyNode(5n);
    h.proposeConfChange(1n, { type: ConfChangeType.ADD_LEARNER, nodeId: 4n, address: 'n4' });
    expect(() => {
      h.proposeConfChange(1n, { type: ConfChangeType.ADD_LEARNER, nodeId: 5n, address: 'n5' });
    }).toThrow(/in progress/);
    h.stabilize();
    h.proposeConfChange(1n, { type: ConfChangeType.ADD_LEARNER, nodeId: 5n, address: 'n5' });
    h.stabilize();
    expect(h.node(1n).raw.status().confState.learners).toEqual([4n, 5n]);
  });

  test('invalid changes are refused', () => {
    const h = elected();
    expect(() => {
      h.proposeConfChange(1n, { type: ConfChangeType.ADD_VOTER, nodeId: 2n, address: 'x' });
    }).toThrow(/already a voter/);
    expect(() => {
      h.proposeConfChange(1n, { type: ConfChangeType.REMOVE_NODE, nodeId: 9n, address: '' });
    }).toThrow(/not a member/);
    expect(() => {
      h.proposeConfChange(2n, { type: ConfChangeType.REMOVE_NODE, nodeId: 3n, address: '' });
    }).toThrow(/leader/);
    const solo = new Harness();
    solo.addNodes([1n]);
    solo.campaign(1n);
    solo.stabilize();
    expect(() => {
      solo.proposeConfChange(1n, { type: ConfChangeType.REMOVE_NODE, nodeId: 1n, address: '' });
    }).toThrow(/last voter/);
  });

  test('removing a follower shrinks the quorum', () => {
    const h = elected();
    h.proposeConfChange(1n, { type: ConfChangeType.REMOVE_NODE, nodeId: 3n, address: '' });
    h.stabilize();
    h.isolate(3n);
    h.propose(1n, 'two-voters');
    h.stabilize();
    expect(h.node(2n).applied).toEqual(['two-voters']);
  });

  test('removing the leader makes it step down and the rest elect a new one', () => {
    const h = elected();
    h.proposeConfChange(1n, { type: ConfChangeType.REMOVE_NODE, nodeId: 1n, address: '' });
    h.stabilize();
    expect(h.node(1n).raw.status().role).toBe('follower');
    for (let i = 0; i < 40; i++) {
      h.tick(2n);
      h.tick(3n);
      h.stabilize();
    }
    const leader = h.leader();
    expect(leader === 2n || leader === 3n).toBe(true);
    // The removed node never campaigns.
    h.tick(1n, 100);
    h.stabilize();
    expect(h.node(1n).raw.status().role).toBe('follower');
  });
});

describe('leadership transfer', () => {
  test('hands over to a caught-up voter with TimeoutNow', () => {
    const h = elected();
    h.propose(1n, 'a');
    h.stabilize();
    expect(h.node(1n).raw.transferLeader(2n).ok).toBe(true);
    h.stabilize();
    expect(h.leader()).toBe(2n);
    expect(h.delivered.some((m) => m.type === MessageType.TIMEOUT_NOW)).toBe(true);
  });

  test('catches a lagging target up first', () => {
    const h = elected();
    h.isolate(3n);
    h.propose(1n, 'a');
    h.stabilize();
    h.heal();
    h.node(1n).raw.transferLeader(3n);
    h.stabilize();
    expect(h.leader()).toBe(3n);
    expect(h.node(3n).applied).toEqual(['a']);
  });

  test('proposals are refused during a transfer and it aborts after an election timeout', () => {
    const h = elected();
    h.isolate(3n);
    h.node(1n).raw.transferLeader(3n);
    const refused = h.node(1n).raw.propose(new Uint8Array([1]));
    expect(refused.ok).toBe(false);
    for (let i = 0; i < 10; i++) {
      h.tick(1n);
      h.stabilize();
    }
    expect(h.node(1n).raw.propose(new Uint8Array([1])).ok).toBe(true);
  });

  test('refuses non-voters and non-leaders', () => {
    const h = elected();
    expect(h.node(1n).raw.transferLeader(9n).ok).toBe(false);
    expect(h.node(2n).raw.transferLeader(3n).ok).toBe(false);
  });
});
