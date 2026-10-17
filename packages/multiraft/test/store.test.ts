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
