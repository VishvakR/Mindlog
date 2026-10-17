import { afterEach, describe, expect, test } from 'vitest';
import { counter, incr } from './support/counter.js';
import { until } from './support/local-cluster.js';
import { storeCluster } from './support/store-cluster.js';

type Cluster = Awaited<ReturnType<typeof storeCluster>>;
let cluster: Cluster | undefined;

afterEach(async () => {
  await cluster?.close();
  cluster = undefined;
});

const ids = [1n, 2n, 3n];
const everywhere = { '1': [1n, 2n], '2': [1n, 2n], '3': [1n, 2n] };

async function leaderOf(c: Cluster, rangeId: bigint) {
  await until(() => c.leader(rangeId) !== undefined);
  const leader = c.leader(rangeId)?.store.replica(rangeId);
  if (!leader) throw new Error('no leader');
  return leader;
}

describe('Store', () => {
  test('hosts several ranges on one node and replicates each one', async () => {
    cluster = await storeCluster(ids, everywhere);
    const c = cluster;
    const one = await leaderOf(c, 1n);
    const two = await leaderOf(c, 2n);
    expect((await one.propose(incr('a'))).ok).toBe(true);
    expect((await two.propose(incr('x'))).ok).toBe(true);
    expect((await two.propose(incr('x'))).ok).toBe(true);
    for (const n of c.nodes.values()) {
      await until(() => (n.store.replica(2n)?.appliedIndex ?? 0n) >= two.appliedIndex);
      await until(() => (n.store.replica(1n)?.appliedIndex ?? 0n) >= one.appliedIndex);
      expect(await counter(n.stateStore, 'a')).toBe(1);
      expect(await counter(n.stateStore, 'x')).toBe(2);
    }
  });

  test('a follower forwards writes and linearizable reads to the leader', async () => {
    cluster = await storeCluster(ids, everywhere);
    const c = cluster;
    const one = await leaderOf(c, 1n);
    const follower = ids.map((id) => c.replica(id, 1n)).find((r) => r && !r.isLeader());
    if (!follower) throw new Error('no follower');
    await follower.leaderKnown();
    expect((await follower.propose(incr('f'))).ok).toBe(true);
    expect((await follower.read('linearizable')).ok).toBe(true);
    expect(one.isLeader()).toBe(true);
  });

  test('all ranges of a node share one tick timer', async () => {
    cluster = await storeCluster(ids, everywhere);
    for (const n of cluster.nodes.values()) expect(n.scheduler.timers).toBe(1);
  });

  test('a message for an unknown range creates its replica, which then catches up', async () => {
    cluster = await storeCluster(ids, { '1': [1n, 2n], '2': [1n, 2n], '3': [1n] });
    const c = cluster;
    const two = await leaderOf(c, 2n);
    expect((await two.propose(incr('x'))).ok).toBe(true);
    await until(() => (c.replica(3n, 2n)?.appliedIndex ?? 0n) >= two.appliedIndex);
    expect(await counter(c.node(3n).stateStore, 'x')).toBe(1);
  });

  test('an idle range quiesces, and wakes for a proposal', async () => {
    cluster = await storeCluster(ids, everywhere);
    const c = cluster;
    const one = await leaderOf(c, 1n);
    expect((await one.propose(incr('a'))).ok).toBe(true);
    await until(() => ids.every((id) => c.replica(id, 1n)?.quiesced === true));
    expect((await one.propose(incr('a'))).ok).toBe(true);
    for (const id of ids) {
      await until(() => (c.replica(id, 1n)?.appliedIndex ?? 0n) >= one.appliedIndex);
      expect(await counter(c.node(id).stateStore, 'a')).toBe(2);
    }
  });

  test('followers of a quiesced range elect a new leader when its node goes away', async () => {
    cluster = await storeCluster(ids, everywhere);
    const c = cluster;
    await leaderOf(c, 1n);
    await until(() => ids.every((id) => c.replica(id, 1n)?.quiesced === true));
    const old = c.leader(1n);
    if (!old) throw new Error('no leader');
    c.net.isolate(
      old.address,
      ids.map((id) => `n${id}`),
    );
    await until(() =>
      [...c.nodes.values()].some((n) => n !== old && n.store.replica(1n)?.isLeader()),
    );
  });
});

describe('Store splits and merges (ADR-0009)', () => {
  const whole = { '1': [1n], '2': [1n], '3': [1n] };
  const noSpans = {};

  async function writeAll(c: Cluster, names: string[]) {
    const one = await leaderOf(c, 1n);
    for (const name of names) expect((await one.propose(incr(name))).ok).toBe(true);
    return one;
  }

  test('a split creates the right range on every node; it elects a leader and takes writes', async () => {
    cluster = await storeCluster(ids, whole, {}, noSpans);
    const c = cluster;
    const one = await writeAll(c, ['a', 'b', 'c', 'x', 'y', 'z']);
    const leaderNode = c.leader(1n);
    if (!leaderNode) throw new Error('no leader');
    expect((await leaderNode.store.split(1n, 2n)).ok).toBe(true);
    for (const id of ids) await until(() => c.replica(id, 2n)?.initialised === true);
    const two = await leaderOf(c, 2n);
    const end = one.descriptor.endKey;
    expect(end.length).toBeGreaterThan(0);
    expect(two.descriptor.startKey).toEqual(end);
    expect((await two.propose(incr('z'))).ok).toBe(true);
    for (const id of ids) {
      await until(() => (c.replica(id, 2n)?.appliedIndex ?? 0n) >= two.appliedIndex);
      expect(await counter(c.node(id).stateStore, 'z')).toBe(2);
    }
  });

  test('a merge folds the right range back and removes its replicas', async () => {
    cluster = await storeCluster(ids, whole, {}, noSpans);
    const c = cluster;
    await writeAll(c, ['a', 'b', 'x', 'y']);
    const at = c.leader(1n);
    if (!at) throw new Error('no leader');
    expect((await at.store.split(1n, 2n)).ok).toBe(true);
    for (const id of ids) await until(() => c.replica(id, 2n)?.initialised === true);
    const two = await leaderOf(c, 2n);
    expect((await two.propose(incr('y'))).ok).toBe(true);

    const rightLeader = c.leader(2n);
    if (!rightLeader) throw new Error('no leader of range 2');
    const elsewhere = [...c.nodes.values()].find((n) => n !== rightLeader);
    const refused = await elsewhere?.store.merge(1n);
    expect(refused?.ok === false && refused.error.code).toBe('NOT_LEADER');
    const merged = await rightLeader.store.merge(1n);
    expect(merged.ok).toBe(true);
    for (const id of ids) {
      await until(() => c.replica(id, 2n) === undefined);
      await until(() => c.replica(id, 1n)?.descriptor.endKey.length === 0);
    }
    const one = await leaderOf(c, 1n);
    expect((await one.propose(incr('y'))).ok).toBe(true);
    for (const id of ids) {
      await until(() => (c.replica(id, 1n)?.appliedIndex ?? 0n) >= one.appliedIndex);
      expect(await counter(c.node(id).stateStore, 'y')).toBe(3);
    }
  });

  test('a split with no room to split is refused', async () => {
    cluster = await storeCluster(ids, whole, {}, noSpans);
    const c = cluster;
    await writeAll(c, ['only']);
    const at = c.leader(1n);
    if (!at) throw new Error('no leader');
    const result = await at.store.split(1n, 2n);
    expect(!result.ok && result.error.code).toBe('INVALID_ARGUMENT');
  });
});
