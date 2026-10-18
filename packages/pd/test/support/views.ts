import { create } from '@bufbuild/protobuf';
import type { ClusterView, NodeView, RangeView } from '@mindlog/pd';
import { DEFAULT_PD_CONFIG } from '@mindlog/pd';
import {
  NodeInfoSchema,
  NodeState,
  RangeDescriptorSchema,
  RangeEpochSchema,
  ReplicaRole,
} from '@mindlog/proto';

const enc = new TextEncoder();

export const node = (id: number, state = NodeState.LIVE, zone = `z${id}`): NodeView => ({
  info: create(NodeInfoSchema, { nodeId: BigInt(id), address: `n${id}:7000`, zone, state }),
  stats: undefined,
});

/** A range on `nodes` (replica ids are 100 * range + node), led by the first. */
export function range(
  id: number,
  nodes: number[],
  options: {
    start?: string;
    end?: string;
    bytes?: number;
    qps?: number;
    hotForMs?: number;
    leader?: number;
  } = {},
): RangeView {
  const replicas = nodes.map((n) => ({
    nodeId: BigInt(n),
    replicaId: BigInt(100 * id + n),
    role: ReplicaRole.VOTER,
  }));
  const leader = options.leader ?? nodes[0] ?? 0;
  return {
    range: create(RangeDescriptorSchema, {
      rangeId: BigInt(id),
      startKey: enc.encode(options.start ?? ''),
      endKey: enc.encode(options.end ?? ''),
      epoch: create(RangeEpochSchema, {}),
      replicas,
    }),
    leaderReplicaId: BigInt(100 * id + leader),
    bytes: BigInt(options.bytes ?? 1000),
    qps: options.qps ?? 0,
    hotForMs: options.hotForMs ?? 0,
    progress: new Map(),
    applied: 0n,
    learnerForMs: 0,
  };
}

export const cluster = (
  nodes: NodeView[],
  ranges: RangeView[],
  busy: number[] = [],
): ClusterView => ({
  nowMs: 1_000_000,
  nodes,
  ranges,
  busy: new Set(busy.map(BigInt)),
  config: { ...DEFAULT_PD_CONFIG, maxBytes: 100_000n, mergeBelowBytes: 20_000n },
});
