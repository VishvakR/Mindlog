import { create } from '@bufbuild/protobuf';
import { ConfChangeType, ConfChangeSchema } from '@mindlog/proto';
import { afterEach, describe, expect, test } from 'vitest';
import { counter, incr } from './support/counter.js';
import { localCluster, until } from './support/local-cluster.js';

type Cluster = Awaited<ReturnType<typeof localCluster>>;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.close();
  cluster = undefined;
});

const ids = [1n, 2n, 3n];

async function withLeader(options = {}): Promise<Cluster> {
  cluster = await localCluster(ids, options);
  const c = cluster;
  await until(() => c.leader() !== undefined);
  return c;
}

describe('Replica', () => {
  test('a single-voter range elects itself and acknowledges writes after apply', async () => {
    cluster = await localCluster([1n]);
    const c = cluster;
    await until(() => c.node(1n).replica.isLeader(), 1000);
    const proposal = await c.node(1n).replica.propose(incr('a'));
    expect(proposal.ok && proposal.value.result.outcome.case).toBe('kv');
    expect(await counter(c.node(1n).stateStore, 'a')).toBe(1);
  });

  test('replicates writes to every node, also when proposed on a follower', async () => {
    const c = await withLeader();
    const leader = c.leader();
    const follower = [...c.nodes.values()].find((n) => n !== leader);
    if (!leader || !follower) throw new Error('no roles');
    await follower.replica.leaderKnown();
    const results = await Promise.all([
      leader.replica.propose(incr('x')),
      follower.replica.propose(incr('x')),
      leader.replica.propose(incr('x')),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    for (const n of c.nodes.values()) {
      await until(() => n.machine.appliedIndex >= leader.machine.appliedIndex);
      expect(await counter(n.stateStore, 'x')).toBe(3);
    }
  });

  test('a retried request id is applied once and both callers get the same result', async () => {
    const c = await withLeader();
    const leader = c.leader();
    if (!leader) throw new Error('no leader');
    const [a, b] = await Promise.all([
      leader.replica.propose(incr('once', 'same-id')),
      leader.replica.propose(incr('once', 'same-id')),
    ]);
    expect(a).toEqual(b);
    expect(await counter(leader.stateStore, 'once')).toBe(1);
  });

  test('reads: linearizable on a follower waits for the leader and local apply', async () => {
    const c = await withLeader();
    const leader = c.leader();
    const follower = [...c.nodes.values()].find((n) => n !== leader);
    if (!leader || !follower) throw new Error('no roles');
    await follower.replica.leaderKnown();
    await leader.replica.propose(incr('r'));
    const read = await follower.replica.read('linearizable');
    expect(read.ok).toBe(true);
    expect(await counter(follower.stateStore, 'r')).toBe(1);
    const lease = await leader.replica.read('lease');
    expect(lease.ok).toBe(true);
  });

  test('a restarted node recovers its log and state', async () => {
    const c = await withLeader();
    const leader = c.leader();
    if (!leader) throw new Error('no leader');
    for (let i = 0; i < 5; i++) await leader.replica.propose(incr('p'));
    const victim = [...c.nodes.values()].find((n) => n !== leader);
    if (!victim) throw new Error('no follower');
    await until(() => victim.machine.appliedIndex >= leader.machine.appliedIndex);
    const restarted = await c.restart(victim.id);
    expect(restarted.machine.appliedIndex).toBeGreaterThanOrEqual(leader.machine.appliedIndex);
    expect(await counter(restarted.stateStore, 'p')).toBe(5);
  });

  test('leader failover: the survivors elect a new leader and keep accepting writes', async () => {
    const c = await withLeader();
    const old = c.leader();
    if (!old) throw new Error('no leader');
    c.net.isolate(old.id, ids);
    await until(() => [...c.nodes.values()].some((n) => n !== old && n.replica.isLeader()));
    const next = [...c.nodes.values()].find((n) => n !== old && n.replica.isLeader());
    const written = await next?.replica.propose(incr('after'));
    expect(written?.ok).toBe(true);
  });

  test('a lagging follower is caught up with a snapshot after compaction', async () => {
    const c = await withLeader({ snapshotEntries: 20, trailingEntries: 2 });
    const leader = c.leader();
    const lagging = [...c.nodes.values()].find((n) => n !== leader);
    if (!leader || !lagging) throw new Error('no roles');
    c.net.isolate(lagging.id, ids);
    for (let i = 0; i < 60; i++) await leader.replica.propose(incr('s'));
    await until(() => leader.replica.status().firstIndex > 30n);
    c.net.cut.clear();
    await until(() => lagging.machine.appliedIndex >= leader.machine.appliedIndex, 5000);
    expect(await counter(lagging.stateStore, 's')).toBe(60);
  });

  test('membership: add a learner, promote it, and transfer leadership to it', async () => {
    const c = await withLeader();
    const leader = c.leader();
    if (!leader) throw new Error('no leader');
    await leader.replica.propose(incr('m'));
    const joiner = await c.addJoiner(4n);
    const added = await leader.replica.changeMembership(
      create(ConfChangeSchema, { type: ConfChangeType.ADD_LEARNER, nodeId: 4n, address: 'n4' }),
    );
    expect(added.ok && added.value.learners).toEqual([4n]);
    await until(() => joiner.machine.appliedIndex >= leader.machine.appliedIndex);
    expect(await counter(joiner.stateStore, 'm')).toBe(1);
    const promoted = await leader.replica.changeMembership(
      create(ConfChangeSchema, { type: ConfChangeType.ADD_VOTER, nodeId: 4n }),
    );
    expect(promoted.ok && promoted.value.voters).toEqual([1n, 2n, 3n, 4n]);
    expect(leader.replica.transferLeader(4n).ok).toBe(true);
    await until(() => joiner.replica.isLeader());
  });

  test('BUSY when too many proposals are pending', async () => {
    const c = await withLeader({ maxPendingProposals: 2 });
    const leader = c.leader();
    if (!leader) throw new Error('no leader');
    const results = await Promise.all([1, 2, 3].map(() => leader.replica.propose(incr('b'))));
    expect(results.flatMap((r) => (r.ok ? [] : [r.error.code]))).toEqual(['BUSY']);
  });

  test('a follower without a known leader refuses writes with NOT_LEADER', async () => {
    cluster = await localCluster(ids);
    const result = await cluster.node(2n).replica.propose(incr('n'));
    expect(result.ok ? undefined : result.error.code).toBe('NOT_LEADER');
  });
});
