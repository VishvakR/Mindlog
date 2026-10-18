import { create } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { decodeKey, err, mindlogError, ok } from '@mindlog/core';
import type { AdminRequest, ClusterResponse } from '@mindlog/proto';
import { AdminRequestSchema, NodeState, ReplicaRole, StepKind } from '@mindlog/proto';
import { z } from 'zod';

/** What the dashboard needs of the placement driver; `PdClient` adapters implement it. */
export interface PdAdmin {
  cluster(): Promise<Result<ClusterResponse, MindlogError>>;
  admin(request: AdminRequest): Promise<Result<string, MindlogError>>;
}

const text = new TextDecoder();

/** A range boundary shown to a person: `tenant/key` for a stored key, else printable ASCII with \xNN escapes. */
export function describeKey(key: Uint8Array): string {
  if (key.length === 0) return '';
  const decoded = decodeKey(key);
  if (decoded.ok && decoded.value.family === 'k')
    return [decoded.value.tenant, ...decoded.value.tuple.map(partText)].join('/');
  return Array.from(key, (b) =>
    b >= 0x20 && b < 0x7f && b !== 0x5c
      ? String.fromCharCode(b)
      : `\\x${b.toString(16).padStart(2, '0')}`,
  ).join('');
}

const partText = (part: unknown): string =>
  part instanceof Uint8Array ? text.decode(part) : String(part);

const operatorView = (o: ClusterResponse['operators'][number]) => ({
  id: o.id.toString(),
  rangeId: o.rangeId.toString(),
  scheduler: o.scheduler,
  step: o.step,
  steps: o.steps.map((s) => StepKind[s.kind]),
  explanation: o.explanation,
  status: o.status,
  createdMs: Number(o.createdMs),
});

/** The cluster as the dashboard shows it: ids as strings, enums as names, keys readable. */
export function clusterView(c: ClusterResponse) {
  const stores = new Map(c.stores.map((s) => [s.node?.nodeId ?? 0n, s] as const));
  return {
    clusterVersion: c.clusterVersion,
    nodes: c.nodes.map((n) => {
      const s = stores.get(n.nodeId);
      return {
        id: n.nodeId.toString(),
        address: n.address,
        zone: n.zone,
        state: NodeState[n.state].replace('NODE_STATE_', '').toLowerCase(),
        binaryVersion: n.binaryVersion,
        ranges: s?.rangeCount ?? 0,
        leaders: s?.leaderCount ?? 0,
        usedBytes: Number(s?.usedBytes ?? 0n),
      };
    }),
    ranges: c.ranges.map((r) => ({
      id: r.rangeId.toString(),
      start: describeKey(r.startKey),
      end: describeKey(r.endKey),
      epoch: `${String(r.epoch?.confVersion ?? 0n)}.${String(r.epoch?.version ?? 0n)}`,
      replicas: r.replicas.map((p) => ({
        replicaId: p.replicaId.toString(),
        nodeId: p.nodeId.toString(),
        role: ReplicaRole[p.role].toLowerCase(),
      })),
    })),
    operators: c.operators.map(operatorView),
    recent: c.recent.map(operatorView),
  };
}

const id = z.string().regex(/^\d+$/, 'a number');

/** Operator actions from the dashboard (PLAN 17); each is one PD admin request. */
export const clusterActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('drain-node'), nodeId: id }),
  z.object({ action: z.literal('undrain-node'), nodeId: id }),
  z.object({ action: z.literal('remove-node'), nodeId: id }),
  z.object({ action: z.literal('transfer-leader'), rangeId: id, replicaId: id }),
  z.object({ action: z.literal('split'), rangeId: id }),
]);
export type ClusterAction = z.infer<typeof clusterActionSchema>;

function toRequest(a: ClusterAction): AdminRequest {
  const action =
    a.action === 'drain-node'
      ? { case: 'drainNode' as const, value: BigInt(a.nodeId) }
      : a.action === 'undrain-node'
        ? { case: 'undrainNode' as const, value: BigInt(a.nodeId) }
        : a.action === 'remove-node'
          ? { case: 'removeNode' as const, value: BigInt(a.nodeId) }
          : a.action === 'split'
            ? { case: 'split' as const, value: { rangeId: BigInt(a.rangeId) } }
            : {
                case: 'transferLeader' as const,
                value: { rangeId: BigInt(a.rangeId), replicaId: BigInt(a.replicaId) },
              };
  return create(AdminRequestSchema, { action });
}

/** The cluster page's service: reads PD's view and forwards operator actions to it. */
export class ClusterDirectory {
  readonly #pd: PdAdmin | undefined;

  constructor(pd: PdAdmin | undefined) {
    this.#pd = pd;
  }

  async overview(): Promise<Result<ReturnType<typeof clusterView>, MindlogError>> {
    if (!this.#pd) return err(mindlogError('UNIMPLEMENTED', 'this node has no placement driver'));
    const cluster = await this.#pd.cluster();
    return cluster.ok ? ok(clusterView(cluster.value)) : cluster;
  }

  async act(action: ClusterAction): Promise<Result<{ message: string }, MindlogError>> {
    if (!this.#pd) return err(mindlogError('UNIMPLEMENTED', 'this node has no placement driver'));
    const done = await this.#pd.admin(toRequest(action));
    return done.ok ? ok({ message: done.value }) : done;
  }
}
