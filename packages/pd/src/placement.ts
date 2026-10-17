import { NodeState, ReplicaRole } from '@mindlog/proto';
import type { ClusterView, NodeView, RangeView } from './cluster-view.js';

/** Nodes that may receive new replicas: live, not draining. */
export const eligibleNodes = (view: ClusterView): NodeView[] =>
  view.nodes.filter((n) => n.info.state === NodeState.LIVE);

export const nodeIdsOf = (rv: RangeView): Set<bigint> =>
  new Set(rv.range.replicas.map((r) => r.nodeId));

export const votersOf = (rv: RangeView) =>
  rv.range.replicas.filter((r) => r.role === ReplicaRole.VOTER);

/** Replicas (voters and learners) held by each node, from the ranges' leaders' reports. */
export function replicaCounts(view: ClusterView): Map<bigint, number> {
  const counts = new Map<bigint, number>(view.nodes.map((n) => [n.info.nodeId, 0]));
  for (const rv of view.ranges)
    for (const r of rv.range.replicas) counts.set(r.nodeId, (counts.get(r.nodeId) ?? 0) + 1);
  return counts;
}

export function leaderCounts(view: ClusterView): Map<bigint, number> {
  const counts = new Map<bigint, number>(view.nodes.map((n) => [n.info.nodeId, 0]));
  for (const rv of view.ranges) {
    const leader = rv.range.replicas.find((r) => r.replicaId === rv.leaderReplicaId);
    if (leader) counts.set(leader.nodeId, (counts.get(leader.nodeId) ?? 0) + 1);
  }
  return counts;
}

const zoneOf = (view: ClusterView, nodeId: bigint): string =>
  view.nodes.find((n) => n.info.nodeId === nodeId)?.info.zone ?? '';

/**
 * Where to put one more replica of `rv`: an eligible node that holds none of
 * its replicas, in a zone the range does not use yet if there is one, with the
 * fewest replicas (ties: lowest id, so plans are reproducible).
 */
export function pickTarget(
  view: ClusterView,
  rv: RangeView,
  exclude: ReadonlySet<bigint> = new Set(),
): NodeView | undefined {
  const holding = nodeIdsOf(rv);
  const zones = new Set([...holding].map((id) => zoneOf(view, id)));
  const counts = replicaCounts(view);
  const candidates = eligibleNodes(view).filter(
    (n) => !holding.has(n.info.nodeId) && !exclude.has(n.info.nodeId),
  );
  candidates.sort((a, b) => {
    const fresh = Number(zones.has(a.info.zone)) - Number(zones.has(b.info.zone));
    if (fresh !== 0) return fresh;
    const load = (counts.get(a.info.nodeId) ?? 0) - (counts.get(b.info.nodeId) ?? 0);
    return load !== 0 ? load : Number(a.info.nodeId - b.info.nodeId);
  });
  return candidates[0];
}
