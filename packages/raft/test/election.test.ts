import { describe, expect, test } from 'vitest';
import { Harness } from './support/harness.js';

const ids = [1n, 2n, 3n];

describe('elections', () => {
  test('a single voter elects itself immediately', () => {
    const h = new Harness();
    h.addNodes([1n]);
    h.campaign(1n);
    h.stabilize();
    expect(h.node(1n).raw.status()).toMatchObject({ role: 'leader', term: 2n, commit: 2n });
  });

  test('three nodes elect the one whose timer fires first', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    expect(h.leader()).toBe(1n);
    for (const id of ids)
      expect(h.node(id).raw.status()).toMatchObject({ term: 2n, lead: 1n, commit: 4n });
  });

  test('ticks alone elect exactly one leader', () => {
    const h = new Harness({ seed: 7n });
    h.addNodes(ids);
    h.tickAll(25);
    const leaders = ids.filter((id) => h.node(id).raw.status().role === 'leader');
    expect(leaders).toHaveLength(1);
  });

  test('PreVote: an isolated node does not inflate its term', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    h.isolate(3n);
    for (let i = 0; i < 100; i++) {
      h.tick(3n);
      h.stabilize();
    }
    expect(h.node(3n).raw.status().term).toBe(2n);
    h.heal();
    h.tickAll(3);
    expect(h.leader()).toBe(1n);
    expect(h.node(1n).raw.status().term).toBe(2n);
  });

  test('without PreVote the isolated node disrupts the leader on rejoin', () => {
    const h = new Harness({ preVote: false, checkQuorum: false });
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    h.isolate(3n);
    h.tick(3n, 30);
    h.stabilize();
    expect(h.node(3n).raw.status().term).toBeGreaterThan(2n);
    h.heal();
    h.tickAll(2);
    expect(h.node(1n).raw.status().term).toBeGreaterThan(2n);
  });

  test('CheckQuorum: a leader that loses its quorum steps down', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    h.isolate(1n);
    for (let i = 0; i < 25; i++) {
      h.tick(1n);
      h.stabilize();
    }
    expect(h.node(1n).raw.status().role).toBe('follower');
  });

  test('a node in its leader lease ignores vote requests (ADR-0007)', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    // Node 3 forces a real campaign (as after a long pause), skipping pre-vote.
    h.node(3n).raw.campaign();
    h.stabilize();
    expect(h.leader()).toBe(1n);
  });

  test('a candidate with a shorter log cannot win (election restriction)', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    h.isolate(3n);
    h.propose(1n, 'a');
    h.stabilize();
    h.heal();
    h.isolate(1n);
    // 3 lacks 'a'; 2 has it and must refuse 3's vote.
    h.tick(3n, 40);
    h.tick(2n, 0);
    h.stabilize();
    for (let i = 0; i < 40; i++) {
      h.tick(3n);
      h.stabilize();
    }
    expect(h.node(3n).raw.status().role).not.toBe('leader');
  });
});
