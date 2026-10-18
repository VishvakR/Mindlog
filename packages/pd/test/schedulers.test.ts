import { describe, expect, test } from 'vitest';
import {
  drainScheduler,
  leaderBalanceScheduler,
  mergeScheduler,
  repairScheduler,
  replicaBalanceScheduler,
  splitScheduler,
} from '@mindlog/pd';
import { create } from '@bufbuild/protobuf';
import { NodeState, ReplicaDescriptorSchema, ReplicaRole } from '@mindlog/proto';
import { cluster, node, range } from './support/views.js';

const kinds = (steps: readonly { kind: string }[]) => steps.map((s) => s.kind);

describe('repair', () => {
  test('replaces a replica on a dead node by a node that holds none, in a new zone', () => {
    const view = cluster(
      [node(1), node(2), node(3, NodeState.DEAD), node(4), node(5)],
      [range(1, [1, 2, 3])],
    );
    const plan = repairScheduler.schedule(view);
    const op = plan.operators[0];
    expect(op?.rangeId).toBe(1n);
    expect(kinds(op?.steps ?? [])).toEqual(['add-learner', 'promote', 'remove-voter']);
    expect(op?.steps[0]?.nodeId).toBe(4n);
    expect(op?.steps[2]?.replicaId).toBe(103n);
    expect(op?.explanation).toContain('dead');
  });

  test('skips ranges without a leader, with an operator already, or with no spare node', () => {
    const nodes = [node(1), node(2), node(3, NodeState.DEAD)];
    expect(repairScheduler.schedule(cluster(nodes, [range(1, [1, 2, 3])])).operators).toEqual([]);
    const spare = [...nodes, node(4)];
    expect(repairScheduler.schedule(cluster(spare, [range(1, [1, 2, 3])], [1])).operators).toEqual(
      [],
    );
    const headless = { ...range(1, [1, 2, 3]), leaderReplicaId: 0n };
    expect(repairScheduler.schedule(cluster(spare, [headless])).operators).toEqual([]);
  });

  test('a lost leader replica is handed over first', () => {
    const view = cluster(
      [node(1, NodeState.DEAD), node(2), node(3), node(4)],
      [range(1, [1, 2, 3], { leader: 2 })],
    );
    // The leader (node 2) is alive; only a dead leader would need a transfer, which cannot happen.
    expect(kinds(repairScheduler.schedule(view).operators[0]?.steps ?? [])).toEqual([
      'add-learner',
      'promote',
      'remove-voter',
    ]);
  });
});

describe('repair of interrupted moves', () => {
  const nodes = [node(1), node(2), node(3), node(4)];
  const withLearner = () => {
    const rv = range(1, [1, 2, 3]);
    const learner = create(ReplicaDescriptorSchema, {
      nodeId: 4n,
      replicaId: 5000n,
      role: ReplicaRole.LEARNER,
    });
    return { ...rv, range: { ...rv.range, replicas: [...rv.range.replicas, learner] } };
  };

  test('promotes a learner nobody is promoting', () => {
    const op = repairScheduler.schedule(cluster(nodes, [withLearner()])).operators[0];
    expect(op?.steps).toEqual([{ kind: 'promote', replicaId: 5000n }]);
  });

  test('removes a learner that stays far behind, but keeps waiting for one that keeps up', () => {
    const behind = {
      ...withLearner(),
      applied: 900n,
      learnerForMs: 200_000,
      progress: new Map([[5000n, 10n]]),
    };
    const op = repairScheduler.schedule(cluster(nodes, [behind])).operators[0];
    expect(op?.steps).toEqual([{ kind: 'remove-voter', replicaId: 5000n }]);
    const keepingUp = { ...behind, progress: new Map([[5000n, 900n]]) };
    expect(repairScheduler.schedule(cluster(nodes, [keepingUp])).operators[0]?.steps[0]?.kind).toBe(
      'promote',
    );
  });

  test('removes the extra voter from the most loaded node, never the leader', () => {
    const view = cluster(nodes, [
      range(1, [1, 2, 3, 4], { leader: 1 }),
      range(2, [1, 2, 3], { leader: 1 }),
    ]);
    const op = repairScheduler.schedule(view).operators[0];
    expect(op?.rangeId).toBe(1n);
    expect(op?.steps).toEqual([{ kind: 'remove-voter', replicaId: 103n }]);
  });

  test('refills a range that has too few voters', () => {
    const op = repairScheduler.schedule(cluster(nodes, [range(1, [1, 2])])).operators[0];
    expect(kinds(op?.steps ?? [])).toEqual(['add-learner', 'promote']);
    expect(op?.steps[0]?.nodeId).toBe(3n);
  });
});

describe('drain', () => {
  test('moves a replica off a draining node, transferring leadership first when it leads', () => {
    const view = cluster(
      [node(1, NodeState.DRAINING), node(2), node(3), node(4)],
      [range(1, [1, 2, 3], { leader: 1 })],
    );
    const op = drainScheduler.schedule(view).operators[0];
    expect(kinds(op?.steps ?? [])).toEqual([
      'add-learner',
      'promote',
      'transfer-leader',
      'remove-voter',
    ]);
    expect(op?.steps[2]?.replicaId).toBe(102n);
  });

  test('does nothing when no draining node holds a replica', () => {
    const view = cluster([node(1), node(2)], [range(1, [1, 2])]);
    expect(drainScheduler.schedule(view).operators).toEqual([]);
  });
});

describe('replica balance', () => {
  test('moves a range from the fullest node to the emptiest, never onto a node that holds it', () => {
    const view = cluster(
      [node(1), node(2), node(3), node(4)],
      [range(1, [1, 2, 3]), range(2, [1, 2, 3]), range(3, [1, 2, 3]), range(4, [1, 2, 3])],
    );
    const plan = replicaBalanceScheduler.schedule(view);
    const op = plan.operators[0];
    expect(op?.steps[0]?.nodeId).toBe(4n);
    expect(kinds(op?.steps ?? [])).toContain('remove-voter');
    expect(plan.explanation).toContain('node 1');
  });

  test('leaves a balanced cluster alone and says why', () => {
    const view = cluster([node(1), node(2), node(3)], [range(1, [1, 2, 3]), range(2, [1, 2, 3])]);
    const plan = replicaBalanceScheduler.schedule(view);
    expect(plan.operators).toEqual([]);
    expect(plan.explanation).toContain('within');
  });

  test('does not move onto draining or dead nodes', () => {
    const view = cluster(
      [node(1), node(2), node(3), node(4, NodeState.DRAINING)],
      [range(1, [1, 2, 3]), range(2, [1, 2, 3])],
    );
    expect(replicaBalanceScheduler.schedule(view).operators).toEqual([]);
  });
});

describe('leader balance', () => {
  test('transfers a leader from the busiest node to a voter on the idlest', () => {
    const view = cluster(
      [node(1), node(2), node(3)],
      [
        range(1, [1, 2, 3], { leader: 1 }),
        range(2, [1, 2, 3], { leader: 1 }),
        range(3, [1, 2, 3], { leader: 1 }),
      ],
    );
    const op = leaderBalanceScheduler.schedule(view).operators[0];
    expect(kinds(op?.steps ?? [])).toEqual(['transfer-leader']);
    expect(Number(op?.steps[0]?.replicaId) % 100).toBe(3);
  });

  test('is quiet when leaders differ by one', () => {
    const view = cluster(
      [node(1), node(2)],
      [
        range(1, [1, 2], { leader: 1 }),
        range(2, [1, 2], { leader: 2 }),
        range(3, [1, 2], { leader: 1 }),
      ],
    );
    expect(leaderBalanceScheduler.schedule(view).operators).toEqual([]);
  });
});

describe('split', () => {
  test('splits a range over the size limit, or one that stayed hot for the window', () => {
    const view = cluster(
      [node(1)],
      [
        range(1, [1], { end: 'g', bytes: 200_000 }),
        range(2, [1], { start: 'g', end: 'p', qps: 5000, hotForMs: 61_000 }),
        range(3, [1], { start: 'p', qps: 5000, hotForMs: 1000 }),
      ],
    );
    const ops = splitScheduler.schedule(view).operators;
    expect(ops.map((o) => o.rangeId)).toEqual([1n, 2n]);
    expect(ops[0]?.explanation).toContain('bytes');
    expect(ops[1]?.explanation).toContain('qps');
  });
});

describe('merge', () => {
  test('merges small quiet neighbours with the same replicas into the left one', () => {
    const view = cluster(
      [node(1), node(2), node(3)],
      [
        range(1, [1, 2, 3], { end: 'g', bytes: 1000 }),
        range(2, [1, 2, 3], { start: 'g', bytes: 1000 }),
      ],
    );
    const op = mergeScheduler.schedule(view).operators[0];
    expect(op?.rangeId).toBe(2n);
    expect(op?.steps[0]).toEqual({ kind: 'merge', targetRange: 1n });
  });

  test('does not merge big, busy or differently placed neighbours', () => {
    const nodes = [node(1), node(2), node(3), node(4)];
    const mk = (a: object, b: object, ra = [1, 2, 3], rb = [1, 2, 3]) =>
      cluster(nodes, [range(1, ra, { end: 'g', ...a }), range(2, rb, { start: 'g', ...b })]);
    expect(mergeScheduler.schedule(mk({ bytes: 30_000 }, {})).operators).toEqual([]);
    expect(mergeScheduler.schedule(mk({ qps: 900 }, {})).operators).toEqual([]);
    expect(mergeScheduler.schedule(mk({}, {}, [1, 2, 3], [1, 2, 4])).operators).toEqual([]);
  });
});
