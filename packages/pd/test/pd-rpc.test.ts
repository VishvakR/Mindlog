import { create } from '@bufbuild/protobuf';
import { afterEach, describe, expect, test } from 'vitest';
import { ConnectPdClient, FIRST_ALLOCATED_ID, InProcessPdClient, startPdServer } from '@mindlog/pd';
import type { PdServer } from '@mindlog/pd';
import {
  NodeInfoSchema,
  RangeDescriptorSchema,
  RangeStatsSchema,
  StoreStatsSchema,
} from '@mindlog/proto';
import { pdNode } from './support/pd-node.js';

const servers: PdServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(node: Awaited<ReturnType<typeof pdNode>>, leader = true) {
  const service = node.service(
    leader
      ? {}
      : {
          group: {
            propose: node.replica.propose.bind(node.replica),
            read: node.replica.read.bind(node.replica),
            isLeader: () => false,
            status: () => ({ term: 1n, lead: 7n }),
          },
        },
  );
  const server = await startPdServer(service, { host: '127.0.0.1', port: 0 });
  servers.push(server);
  return { service, address: `127.0.0.1:${server.address.port}` };
}

const stats = (id: number) =>
  create(StoreStatsSchema, {
    node: create(NodeInfoSchema, { nodeId: BigInt(id), address: `n${id}:7000`, binaryVersion: 4 }),
  });

describe('PD over Connect', () => {
  test('serves ids, timestamps, heartbeats and the directory to a client', async () => {
    const node = await pdNode();
    const { address } = await serve(node);
    const client = new ConnectPdClient([address]);
    const first = await client.allocIds(3);
    expect(first.ok && first.value).toBe(FIRST_ALLOCATED_ID);
    const a = await client.tso(1);
    const b = await client.tso(5);
    expect(a.ok && b.ok && b.value > a.value).toBe(true);
    const beat = await client.storeHeartbeat(stats(1));
    expect(beat.ok && beat.value.nodes.map((n) => n.address)).toEqual(['n1:7000']);
    const range = create(RangeDescriptorSchema, { rangeId: 1n });
    const reported = await client.rangeHeartbeat(
      create(RangeStatsSchema, { range, leaderReplicaId: 101n }),
    );
    expect(reported.ok).toBe(true);
    const found = await client.getRange(new TextEncoder().encode('k'));
    expect(found.ok && found.value.range.rangeId).toBe(1n);
    const scan = await client.scanRanges(new Uint8Array(), 5);
    expect(scan.ok && scan.value).toHaveLength(1);
  });

  test('finds the leader among the endpoints, skipping followers and dead ones', async () => {
    const node = await pdNode();
    const follower = await serve(node, false);
    const leader = await serve(node, true);
    const client = new ConnectPdClient(['127.0.0.1:1', follower.address, leader.address]);
    const r = await client.allocIds(1);
    expect(r.ok).toBe(true);
    const again = await client.allocIds(1);
    expect(r.ok && again.ok && again.value === r.value + 1n).toBe(true);
  });

  test('reports NOT_LEADER with the leader hint when no endpoint leads, and errors cross the wire intact', async () => {
    const node = await pdNode();
    const follower = await serve(node, false);
    const client = new ConnectPdClient([follower.address]);
    const r = await client.allocIds(1);
    expect(!r.ok && r.error.code).toBe('NOT_LEADER');
    expect(!r.ok && r.error.fields).toEqual({ leader: '7' });
    const leader = await serve(node, true);
    const bad = await new ConnectPdClient([leader.address]).allocIds(0);
    expect(!bad.ok && bad.error.code).toBe('INVALID_ARGUMENT');
  });

  test('an in-process client behaves the same', async () => {
    const node = await pdNode();
    const client = new InProcessPdClient(node.service());
    const r = await client.allocIds(2);
    expect(r.ok && r.value).toBe(FIRST_ALLOCATED_ID);
    expect((await client.getRange(new Uint8Array())).ok).toBe(false);
  });
});
