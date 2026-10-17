import { create } from '@bufbuild/protobuf';
import { describe, expect, test } from 'vitest';
import {
  NodeInfoSchema,
  NodeState,
  RangeDescriptorSchema,
  RangeEpochSchema,
  RangeStatsSchema,
  ReplicaRole,
  StepKind,
  StoreStatsSchema,
} from '@mindlog/proto';
import { FIRST_ALLOCATED_ID } from '@mindlog/pd';
import { pdNode } from './support/pd-node.js';

const enc = new TextEncoder();

const heartbeat = (id: number, binaryVersion = 4) =>
  create(StoreStatsSchema, {
    node: create(NodeInfoSchema, {
      nodeId: BigInt(id),
      address: `n${id}:7000`,
      zone: `z${id}`,
      binaryVersion,
    }),
  });

function rangeStats(id: number, nodes: number[], leader: number, extra: { bytes?: bigint } = {}) {
  return create(RangeStatsSchema, {
    range: create(RangeDescriptorSchema, {
      rangeId: BigInt(id),
      epoch: create(RangeEpochSchema, {}),
      replicas: nodes.map((n) => ({
        nodeId: BigInt(n),
        replicaId: BigInt(100 * id + n),
        role: ReplicaRole.VOTER,
      })),
    }),
    leaderReplicaId: BigInt(100 * id + leader),
    bytes: extra.bytes ?? 100n,
  });
}

describe('PdService', () => {
  test('allocates unique ids', async () => {
    const node = await pdNode();
    const pd = node.service();
    const [a, b] = [await pd.allocIds(2), await pd.allocIds(2)];
    expect(a.ok && a.value).toBe(FIRST_ALLOCATED_ID);
    expect(b.ok && b.value).toBe(FIRST_ALLOCATED_ID + 2n);
  });

  test('timestamps strictly increase, also across a new leader term and a clock that stood still', async () => {
    const node = await pdNode();
    const first = node.service();
    const seen: bigint[] = [];
    for (let i = 0; i < 20; i++) {
      const t = await first.tso(1 + (i % 3));
      expect(t.ok).toBe(true);
      if (t.ok) seen.push(t.value);
    }
    // A second service on the same group stands in for a new leader: no state in memory.
    const second = node.service();
    for (let i = 0; i < 5; i++) {
      const t = await second.tso(2);
      if (t.ok) seen.push(t.value);
    }
    // Even with the clock jumping back, nothing already issued repeats.
    node.clock.setWall(1_000n);
    const third = node.service();
    const t = await third.tso(1);
    if (t.ok) seen.push(t.value);
    expect(seen).toHaveLength(26);
    expect(seen.every((v, i) => i === 0 || v > (seen[i - 1] as bigint))).toBe(true);
  });

  test('registers nodes from store heartbeats and tells them about each other', async () => {
    const node = await pdNode();
    const pd = node.service();
    await pd.storeHeartbeat(heartbeat(1));
    const reply = await pd.storeHeartbeat(heartbeat(2));
    expect(reply.ok && reply.value.nodes.map((n) => [n.nodeId, n.state])).toEqual([
      [1n, NodeState.LIVE],
      [2n, NodeState.LIVE],
    ]);
    expect(reply.ok && reply.value.nodes[1]?.address).toBe('n2:7000');
  });

  test('walks a silent node through suspect to dead, and back to live when it returns', async () => {
    const node = await pdNode();
    const pd = node.service();
    await pd.storeHeartbeat(heartbeat(1));
    await pd.storeHeartbeat(heartbeat(2));
    const states = async () => {
      const c = await pd.cluster();
      return c.ok ? c.value.nodes.map((n) => n.state) : [];
    };
    node.clock.advance(2500n);
    await pd.storeHeartbeat(heartbeat(1));
    await pd.tick();
    expect(await states()).toEqual([NodeState.LIVE, NodeState.LIVE]);
    node.clock.advance(1500n);
    await pd.storeHeartbeat(heartbeat(1));
    await pd.tick();
    expect(await states()).toEqual([NodeState.LIVE, NodeState.SUSPECT]);
    node.clock.advance(11_000n);
    await pd.storeHeartbeat(heartbeat(1));
    await pd.tick();
    expect(await states()).toEqual([NodeState.LIVE, NodeState.DEAD]);
    await pd.storeHeartbeat(heartbeat(2));
    expect(await states()).toEqual([NodeState.LIVE, NodeState.LIVE]);
  });

  test('a drained node stays drained when it heartbeats', async () => {
    const node = await pdNode();
    const pd = node.service();
    await pd.storeHeartbeat(heartbeat(1));
    expect((await pd.admin({ action: { case: 'drainNode', value: 1n } } as never)).ok).toBe(true);
    await pd.storeHeartbeat(heartbeat(1));
    const c = await pd.cluster();
    expect(c.ok && c.value.nodes[0]?.state).toBe(NodeState.DRAINING);
  });

  test('the cluster version is the lowest binary version among live nodes, and only rises', async () => {
    const node = await pdNode();
    const pd = node.service();
    await pd.storeHeartbeat(heartbeat(1, 4));
    await pd.storeHeartbeat(heartbeat(2, 3));
    node.clock.advance(3000n);
    await pd.tick();
    let c = await pd.cluster();
    expect(c.ok && c.value.clusterVersion).toBe(3);
    await pd.storeHeartbeat(heartbeat(2, 4));
    await pd.tick();
    c = await pd.cluster();
    expect(c.ok && c.value.clusterVersion).toBe(4);
  });

  test('stores the directory from range heartbeats and answers lookups', async () => {
    const node = await pdNode();
    const pd = node.service();
    await pd.storeHeartbeat(heartbeat(1));
    const reply = await pd.rangeHeartbeat(rangeStats(1, [1], 1));
    expect(reply.ok && reply.value.operator).toBeUndefined();
    const found = await pd.getRange(enc.encode('anything'));
    expect(found.ok && found.value.range?.rangeId).toBe(1n);
    expect(found.ok && found.value.leaderReplicaId).toBe(101n);
    const scan = await pd.scanRanges(new Uint8Array(), 10);
    expect(scan.ok && scan.value.map((r) => r.rangeId)).toEqual([1n]);
  });

  test('after the quiet period, a range with a replica on a dead node gets a repair operator it hands to the leader', async () => {
    const node = await pdNode();
    const pd = node.service();
    for (const id of [1, 2, 3, 4]) await pd.storeHeartbeat(heartbeat(id));
    await pd.rangeHeartbeat(rangeStats(1, [1, 2, 3], 1));
    await pd.tick(); // quiet period: nothing scheduled yet
    node.clock.advance(1500n);
    // Node 3 goes silent; the others keep reporting.
    for (let i = 0; i < 14; i++) {
      node.clock.advance(1000n);
      for (const id of [1, 2, 4]) await pd.storeHeartbeat(heartbeat(id));
      await pd.rangeHeartbeat(rangeStats(1, [1, 2, 3], 1));
      await pd.tick();
    }
    const reply = await pd.rangeHeartbeat(rangeStats(1, [1, 2, 3], 1));
    const op = reply.ok ? reply.value.operator : undefined;
    expect(op?.scheduler).toBe('repair');
    expect(op?.steps[op.step]?.kind).toBe(StepKind.ADD_LEARNER);
    expect(op?.steps[0]).toMatchObject({ nodeId: 4n, address: 'n4:7000' });
    expect(op?.explanation).toContain('dead');
    // The operator is part of the dashboard's picture, and so is why the schedulers did what they did.
    const c = await pd.cluster();
    expect(c.ok && c.value.operators.map((o) => o.rangeId)).toEqual([1n]);
    // Later runs say why they did nothing: the range already has an operator.
    expect([...pd.explanations().keys()]).toContain('repair');
  });

  test('refuses requests when it does not lead', async () => {
    const node = await pdNode();
    const pd = node.service({
      group: {
        propose: node.replica.propose.bind(node.replica),
        read: node.replica.read.bind(node.replica),
        isLeader: () => false,
        status: () => ({ term: 1n, lead: 7n }),
      },
    });
    const r = await pd.allocIds(1);
    expect(!r.ok && r.error.code).toBe('NOT_LEADER');
    expect(!r.ok && r.error.fields).toEqual({ leader: '7' });
  });
});
