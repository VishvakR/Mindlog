import { NodeState, ReplicaRole } from '@mindlog/proto';
import type {
  ClusterView,
  Plan,
  PlannedOperator,
  PlannedStep,
  RangeView,
  Scheduler,
} from './cluster-view.js';
import {
  eligibleNodes,
  leaderCounts,
  nodeIdsOf,
  pickTarget,
  replicaCounts,
  votersOf,
} from './placement.js';

const nothing = (scheduler: string, why: string): Plan => ({
  scheduler,
  operators: [],
  explanation: why,
});

const free = (view: ClusterView, rv: RangeView): boolean => !view.busy.has(rv.range.rangeId);
const hasLeader = (rv: RangeView): boolean => rv.leaderReplicaId !== 0n;

/** Move `replica` of `rv` to a new node: learner, promote, (hand over leadership,) remove. */
function movement(rv: RangeView, replicaId: bigint, target: bigint): PlannedStep[] {
  const leaderHolds = rv.leaderReplicaId === replicaId;
  const to = votersOf(rv).find((v) => v.replicaId !== replicaId);
  return [
    { kind: 'add-learner', nodeId: target },
    { kind: 'promote', replicaId: 0n },
    ...(leaderHolds && to ? [{ kind: 'transfer-leader', replicaId: to.replicaId } as const] : []),
    { kind: 'remove-voter', replicaId },
  ];
}

/**
 * Keeps ranges at full strength: replaces replicas on dead nodes, finishes moves a PD failover
 * interrupted (a learner nobody promoted, an extra voter nobody removed), and refills a range that
 * has fewer voters than `replicas`.
 */
export const repairScheduler: Scheduler = {
  name: 'repair',
  schedule(view) {
    const dead = new Set(
      view.nodes.filter((n) => n.info.state === NodeState.DEAD).map((n) => n.info.nodeId),
    );
    const counts = replicaCounts(view);
    const operators: PlannedOperator[] = [];
    for (const rv of view.ranges) {
      if (!free(view, rv) || !hasLeader(rv)) continue;
      const id = rv.range.rangeId;
      const lost = rv.range.replicas.find((r) => dead.has(r.nodeId));
      const target = pickTarget(view, rv);
      const voters = votersOf(rv);
      const learner = rv.range.replicas.find((r) => r.role === ReplicaRole.LEARNER);
      if (lost && target) {
        operators.push({
          rangeId: id,
          steps: movement(rv, lost.replicaId, target.info.nodeId),
          explanation: `replica ${lost.replicaId} is on node ${lost.nodeId}, which is dead; node ${target.info.nodeId} holds no replica of range ${id}`,
        });
      } else if (learner && !dead.has(learner.nodeId)) {
        const behind = (rv.progress.get(learner.replicaId) ?? 0n) < rv.applied;
        operators.push(
          behind && rv.learnerForMs > view.config.learnerTimeoutMs
            ? {
                rangeId: id,
                steps: [{ kind: 'remove-voter', replicaId: learner.replicaId }],
                explanation: `learner ${learner.replicaId} of range ${id} has not caught up in ${rv.learnerForMs} ms; removing it`,
              }
            : {
                rangeId: id,
                steps: [{ kind: 'promote', replicaId: learner.replicaId }],
                explanation: `range ${id} has a learner (replica ${learner.replicaId}) that no operator is promoting`,
              },
        );
      } else if (voters.length > view.config.replicas) {
        const extra = [...voters]
          .filter((v) => v.replicaId !== rv.leaderReplicaId)
          .sort(
            (a, b) =>
              (counts.get(b.nodeId) ?? 0) - (counts.get(a.nodeId) ?? 0) ||
              Number(b.nodeId - a.nodeId),
          )[0];
        if (extra)
          operators.push({
            rangeId: id,
            steps: [{ kind: 'remove-voter', replicaId: extra.replicaId }],
            explanation: `range ${id} has ${voters.length} voters, ${view.config.replicas} wanted; removing the one on node ${extra.nodeId}, which holds the most replicas`,
          });
      } else if (voters.length < view.config.replicas && target) {
        operators.push({
          rangeId: id,
          steps: [
            { kind: 'add-learner', nodeId: target.info.nodeId },
            { kind: 'promote', replicaId: 0n },
          ],
          explanation: `range ${id} has ${voters.length} voters, ${view.config.replicas} wanted; node ${target.info.nodeId} holds none`,
        });
      }
    }
    return operators.length > 0
      ? {
          scheduler: 'repair',
          operators,
          explanation: `${operators.length} range(s) below or above full strength`,
        }
      : nothing('repair', 'every range has its replicas on live nodes');
  },
};

/** Moves replicas off draining nodes. */
export const drainScheduler: Scheduler = {
  name: 'drain',
  schedule(view) {
    const draining = new Set(
      view.nodes.filter((n) => n.info.state === NodeState.DRAINING).map((n) => n.info.nodeId),
    );
    const operators: PlannedOperator[] = [];
    for (const rv of view.ranges) {
      if (!free(view, rv) || !hasLeader(rv)) continue;
      const held = rv.range.replicas.find((r) => draining.has(r.nodeId));
      const target = held && pickTarget(view, rv);
      if (!held || !target) continue;
      operators.push({
        rangeId: rv.range.rangeId,
        steps: movement(rv, held.replicaId, target.info.nodeId),
        explanation: `node ${held.nodeId} is draining; moving replica ${held.replicaId} of range ${rv.range.rangeId} to node ${target.info.nodeId}`,
      });
    }
    return operators.length > 0
      ? {
          scheduler: 'drain',
          operators,
          explanation: `${operators.length} range(s) on draining nodes`,
        }
      : nothing('drain', 'no draining node holds a replica');
  },
};

/** Evens out the number of replicas per node (moves one range per run). */
export const replicaBalanceScheduler: Scheduler = {
  name: 'replica-balance',
  schedule(view) {
    const counts = replicaCounts(view);
    const nodes = eligibleNodes(view).map((n) => n.info.nodeId);
    if (nodes.length < 2) return nothing('replica-balance', 'fewer than two eligible nodes');
    const sorted = [...nodes].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || Number(a - b),
    );
    const most = sorted[0] as bigint;
    const least = sorted[sorted.length - 1] as bigint;
    const [hi, lo] = [counts.get(most) ?? 0, counts.get(least) ?? 0];
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const slack = Math.max(1, Math.floor(total / nodes.length / 10));
    if (hi - lo <= slack)
      return nothing(
        'replica-balance',
        `node ${most} holds ${hi}, node ${least} holds ${lo}: within ${slack}`,
      );
    for (const rv of view.ranges) {
      if (!free(view, rv) || !hasLeader(rv) || nodeIdsOf(rv).has(least)) continue;
      const held = rv.range.replicas.find((r) => r.nodeId === most && r.role === ReplicaRole.VOTER);
      if (!held || votersOf(rv).length < 2) continue;
      return {
        scheduler: 'replica-balance',
        operators: [
          {
            rangeId: rv.range.rangeId,
            steps: movement(rv, held.replicaId, least),
            explanation: `node ${most} holds ${hi} replicas, node ${least} holds ${lo} (slack ${slack}); moving range ${rv.range.rangeId}`,
          },
        ],
        explanation: `rebalancing from node ${most} (${hi}) to node ${least} (${lo})`,
      };
    }
    return nothing(
      'replica-balance',
      `node ${most} has ${hi} replicas but no range can move to node ${least}`,
    );
  },
};

/** Evens out the number of leaders per node. */
export const leaderBalanceScheduler: Scheduler = {
  name: 'leader-balance',
  schedule(view) {
    const counts = leaderCounts(view);
    const nodes = eligibleNodes(view).map((n) => n.info.nodeId);
    if (nodes.length < 2) return nothing('leader-balance', 'fewer than two eligible nodes');
    const sorted = [...nodes].sort(
      (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || Number(a - b),
    );
    const most = sorted[0] as bigint;
    const least = sorted[sorted.length - 1] as bigint;
    const [hi, lo] = [counts.get(most) ?? 0, counts.get(least) ?? 0];
    if (hi - lo < 2)
      return nothing('leader-balance', `node ${most} leads ${hi}, node ${least} leads ${lo}`);
    for (const rv of view.ranges) {
      if (!free(view, rv) || !hasLeader(rv)) continue;
      const leader = rv.range.replicas.find((r) => r.replicaId === rv.leaderReplicaId);
      const to = votersOf(rv).find((v) => v.nodeId === least);
      if (leader?.nodeId !== most || !to) continue;
      return {
        scheduler: 'leader-balance',
        operators: [
          {
            rangeId: rv.range.rangeId,
            steps: [{ kind: 'transfer-leader', replicaId: to.replicaId }],
            explanation: `node ${most} leads ${hi} ranges, node ${least} leads ${lo}; moving the leader of range ${rv.range.rangeId}`,
          },
        ],
        explanation: `leader balance from node ${most} (${hi}) to node ${least} (${lo})`,
      };
    }
    return nothing('leader-balance', `no range led by node ${most} has a voter on node ${least}`);
  },
};

/** Splits ranges that are too big, or that have been too busy for the configured window. */
export const splitScheduler: Scheduler = {
  name: 'split',
  schedule(view) {
    const operators: PlannedOperator[] = [];
    for (const rv of view.ranges) {
      if (!free(view, rv) || !hasLeader(rv)) continue;
      const big = rv.bytes > view.config.maxBytes;
      const hot = rv.qps >= view.config.splitQps && rv.hotForMs >= view.config.splitQpsWindowMs;
      if (!big && !hot) continue;
      operators.push({
        rangeId: rv.range.rangeId,
        steps: [{ kind: 'split', targetRange: 0n }],
        explanation: big
          ? `range ${rv.range.rangeId} holds ${rv.bytes} bytes, over the ${view.config.maxBytes} limit`
          : `range ${rv.range.rangeId} has run at ${rv.qps.toFixed(0)} qps for ${rv.hotForMs} ms`,
      });
    }
    return operators.length > 0
      ? { scheduler: 'split', operators, explanation: `${operators.length} range(s) to split` }
      : nothing('split', 'no range is over the size or load limit');
  },
};

/** Merges small, quiet neighbours that have the same replicas (executed on the right range's leader). */
export const mergeScheduler: Scheduler = {
  name: 'merge',
  schedule(view) {
    const byStart = [...view.ranges].sort((a, b) =>
      Buffer.compare(a.range.startKey, b.range.startKey),
    );
    for (let i = 0; i + 1 < byStart.length; i++) {
      const [left, right] = [byStart[i] as RangeView, byStart[i + 1] as RangeView];
      if (
        left.range.endKey.length === 0 ||
        Buffer.compare(left.range.endKey, right.range.startKey) !== 0
      )
        continue;
      if (!free(view, left) || !free(view, right) || !hasLeader(right)) continue;
      const small = (v: RangeView) =>
        v.bytes < view.config.mergeBelowBytes && v.qps < view.config.splitQps / 4;
      const same =
        [...nodeIdsOf(left)].sort().join() === [...nodeIdsOf(right)].sort().join() &&
        left.range.replicas.length === right.range.replicas.length;
      if (!small(left) || !small(right) || !same) continue;
      if (left.bytes + right.bytes >= view.config.maxBytes / 2n) continue;
      return {
        scheduler: 'merge',
        operators: [
          {
            rangeId: right.range.rangeId,
            steps: [{ kind: 'merge', targetRange: left.range.rangeId }],
            explanation: `ranges ${left.range.rangeId} and ${right.range.rangeId} are small (${left.bytes} + ${right.bytes} bytes), quiet, and held by the same nodes`,
          },
        ],
        explanation: `merge range ${right.range.rangeId} into ${left.range.rangeId}`,
      };
    }
    return nothing('merge', 'no neighbouring ranges are small, quiet and co-located');
  },
};

/** The schedulers in priority order: repairing and draining come before balancing. */
export const DEFAULT_SCHEDULERS: readonly Scheduler[] = [
  repairScheduler,
  drainScheduler,
  splitScheduler,
  replicaBalanceScheduler,
  leaderBalanceScheduler,
  mergeScheduler,
];
