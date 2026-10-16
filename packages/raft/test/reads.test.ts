import { MessageType } from '@mindlog/proto';
import { describe, expect, test } from 'vitest';
import { Harness, enc } from './support/harness.js';

const ids = [1n, 2n, 3n];

function elected(): Harness {
  const h = new Harness();
  h.addNodes(ids);
  h.campaign(1n);
  h.stabilize();
  return h;
}

describe('ReadIndex', () => {
  test('the leader answers after a heartbeat round with the commit index', () => {
    const h = elected();
    h.propose(1n, 'a');
    h.stabilize();
    expect(h.node(1n).raw.readIndex(enc('r1')).ok).toBe(true);
    h.stabilize();
    expect(h.node(1n).readStates).toEqual([{ index: 5n, context: 'r1' }]);
    expect(h.delivered.some((m) => m.type === MessageType.HEARTBEAT && m.context.length > 0)).toBe(
      true,
    );
  });

  test('a follower read is forwarded and answered by the leader', () => {
    const h = elected();
    h.node(3n).raw.readIndex(enc('f1'));
    h.stabilize();
    expect(h.node(3n).readStates).toEqual([{ index: 4n, context: 'f1' }]);
  });

  test('an isolated leader cannot confirm a read', () => {
    const h = elected();
    h.isolate(1n);
    h.node(1n).raw.readIndex(enc('x'));
    h.stabilize();
    expect(h.node(1n).readStates).toEqual([]);
  });

  test('reads wait for the first commit of a new term', () => {
    const h = new Harness();
    h.addNodes(ids);
    h.campaign(1n);
    // Deliver votes only: node 1 leads but has not committed its no-op.
    const votes = new Set([
      MessageType.PRE_VOTE,
      MessageType.PRE_VOTE_RESPONSE,
      MessageType.VOTE,
      MessageType.VOTE_RESPONSE,
    ]);
    for (let i = 0; i < 6 && h.node(1n).raw.status().role !== 'leader'; i++) {
      for (const id of ids) h.processReady(id);
      h.deliver((m) => votes.has(m.type));
    }
    expect(h.node(1n).raw.status().role).toBe('leader');
    expect(h.node(1n).raw.readIndex(enc('early')).ok).toBe(true);
    expect(h.node(1n).readStates).toEqual([]);
    h.stabilize();
    expect(h.node(1n).readStates).toEqual([{ index: 4n, context: 'early' }]);
  });

  test('a single voter answers immediately', () => {
    const h = new Harness();
    h.addNodes([1n]);
    h.campaign(1n);
    h.stabilize();
    h.node(1n).raw.readIndex(enc('solo'));
    h.stabilize();
    expect(h.node(1n).readStates).toEqual([{ index: 2n, context: 'solo' }]);
  });

  test('a follower without a leader refuses with NOT_LEADER', () => {
    const h = new Harness();
    h.addNodes(ids);
    const result = h.node(2n).raw.readIndex(enc('none'));
    expect(result.ok ? undefined : result.error.code).toBe('NOT_LEADER');
  });
});

describe('leader lease (ADR-0007)', () => {
  test('holds after a quorum echoes a recent tick and expires without acks', () => {
    const h = elected();
    const leader = h.node(1n).raw;
    h.tickAll(1);
    expect(leader.leaseRead()).toBe(4n);
    h.isolate(1n);
    for (let i = 0; i < 8; i++) {
      h.tick(1n);
      h.stabilize();
    }
    expect(leader.leaseRead()).toBe(4n);
    for (let i = 0; i < 3; i++) {
      h.tick(1n);
      h.stabilize();
    }
    expect(leader.leaseRead()).toBeUndefined();
  });

  test('is never valid on followers', () => {
    const h = elected();
    h.tickAll(1);
    expect(h.node(2n).raw.leaseRead()).toBeUndefined();
  });

  test('needs CheckQuorum', () => {
    const h = new Harness({ checkQuorum: false });
    h.addNodes(ids);
    h.campaign(1n);
    h.stabilize();
    h.tickAll(1);
    expect(h.node(1n).raw.leaseRead()).toBeUndefined();
  });
});
