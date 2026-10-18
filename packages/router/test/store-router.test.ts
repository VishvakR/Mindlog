import { create } from '@bufbuild/protobuf';
import { ManualClock, err, mindlogError, ok } from '@mindlog/core';
import { headerKey } from '@mindlog/kv';
import type { PdClient, Replica } from '@mindlog/multiraft';
import type { NodeInfo, RangeDescriptor } from '@mindlog/proto';
import { NodeInfoSchema, RangeDescriptorSchema, ReplicaRole } from '@mindlog/proto';
import { MemoryStore } from '@mindlog/storage';
import { describe, expect, test } from 'vitest';
import { StoreRouter } from '@mindlog/router';

const enc = new TextEncoder();
const split = headerKey('default', enc.encode('m'));

const descriptor = (
  rangeId: bigint,
  nodes: bigint[],
  bounds: { startKey?: Uint8Array; endKey?: Uint8Array } = {},
) =>
  create(RangeDescriptorSchema, {
    rangeId,
    replicas: nodes.map((nodeId) => ({
      nodeId,
      replicaId: nodeId * 10n + rangeId,
      role: ReplicaRole.VOTER,
    })),
    ...bounds,
  });

/** Just enough of a Replica for placement. */
function fakeReplica(d: RangeDescriptor, leader: boolean, lead = 0n, addresses = {}): Replica {
  return {
    rangeId: d.rangeId,
    initialised: true,
    descriptor: d,
    isLeader: () => leader,
    status: () => ({ lead, confState: { addresses } }),
  } as unknown as Replica;
}

function router(local: Replica[], pd?: Partial<PdClient>) {
  const sent: Array<{ address: string; rangeId: bigint }> = [];
  const nodes = new Map<bigint, NodeInfo>([
    [2n, create(NodeInfoSchema, { nodeId: 2n, address: 'n2:7000' })],
    [3n, create(NodeInfoSchema, { nodeId: 3n, address: 'n3:7000' })],
  ]);
  return {
    sent,
    router: new StoreRouter({
      ranges: {
        replicas: () => local,
        replica: (id) => local.find((r) => r.rangeId === id),
      },
      state: new MemoryStore(),
      ...(pd ? { pd: pd as PdClient } : {}),
      nodes: () => nodes,
      clock: new ManualClock(1_000n),
      send: (address, rangeId) => {
        sent.push({ address, rangeId });
        return Promise.resolve(err(mindlogError('UNAVAILABLE', 'test')));
      },
    }),
  };
}

describe('StoreRouter', () => {
  test('a range this node leads is served by its local replica', async () => {
    const left = descriptor(1n, [1n], { endKey: split });
    const { router: r } = router([fakeReplica(left, true)]);
    const placed = await r.place('default', [enc.encode('apple')]);
    expect(placed.ok && placed.value[0]?.local?.rangeId).toBe(1n);
  });

  test('a local follower points at the leader from its own configuration', async () => {
    const left = descriptor(1n, [1n, 2n], { endKey: split });
    const replica = fakeReplica(left, false, 12n, { '12': 'n2:7000' });
    const { router: r } = router([replica]);
    const placed = await r.place('default', [enc.encode('apple')]);
    expect(placed.ok && placed.value[0]).toMatchObject({ rangeId: 1n, address: 'n2:7000' });
  });

  test('a range on other nodes is found through PD, cached, and re-read after refresh', async () => {
    const right = descriptor(2n, [2n, 3n], { startKey: split });
    let calls = 0;
    const pd = {
      getRange: () => {
        calls++;
        return Promise.resolve(ok({ range: right, leaderReplicaId: 32n }));
      },
    };
    const { router: r } = router([], pd);
    const first = await r.place('default', [enc.encode('zebra')]);
    expect(first.ok && first.value[0]?.address).toBe('n3:7000');
    await r.place('default', [enc.encode('zulu')]);
    expect(calls).toBe(1);
    const placement = first.ok ? first.value[0] : undefined;
    if (placement) await r.refresh(placement);
    expect(calls).toBe(2);
  });

  test('forwarding without a known leader fails as NOT_LEADER before sending', async () => {
    const { router: r, sent } = router([]);
    const reply = await r.forward(
      { rangeId: 5n },
      { tenant: 't', principal: 'p' },
      {
        kind: 'command',
        argv: [],
      },
    );
    expect(!reply.ok && reply.error.code).toBe('NOT_LEADER');
    expect(sent).toEqual([]);
  });

  test('ranges lists local and PD ranges in key order', async () => {
    const left = descriptor(1n, [1n], { endKey: split });
    const right = descriptor(2n, [2n], { startKey: split });
    const pd = { scanRanges: () => Promise.resolve(ok([left, right])) };
    const { router: r } = router([fakeReplica(left, true)], pd);
    const all = await r.ranges();
    expect(all.ok && all.value.map((p) => p.rangeId)).toEqual([1n, 2n]);
  });
});
