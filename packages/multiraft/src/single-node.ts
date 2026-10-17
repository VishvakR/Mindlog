import { SeededRandom } from '@mindlog/core';
import { DEFAULT_RAFT_OPTIONS } from '@mindlog/raft';
import type { ReplicaDeps, ReplicaOptions } from './replica.js';
import { Replica } from './replica.js';
import { SINGLE_NODE_TRANSPORT } from './single-node-transport.js';
import { SystemScheduler } from './system-scheduler.js';

/** PLAN 7.4 / Appendix B defaults for a replica. */
export const DEFAULT_REPLICA_OPTIONS: ReplicaOptions = {
  ...DEFAULT_RAFT_OPTIONS,
  tickMs: 100,
  snapshotEntries: 10_000,
  trailingEntries: 1_000,
  snapshotChunkBytes: 1024 * 1024,
  maxPendingProposals: 10_000,
};

export type SingleNodeDeps = Omit<
  ReplicaDeps,
  'rangeId' | 'raftId' | 'options' | 'transport' | 'scheduler' | 'random' | 'bootstrap'
> &
  Partial<Pick<ReplicaDeps, 'rangeId' | 'raftId' | 'scheduler' | 'random'>> & {
    readonly options?: Partial<ReplicaOptions>;
  };

/**
 * A started one-voter range (`--single-node`, and tests): it bootstraps
 * itself, elects itself without waiting for a timeout, and resolves once it
 * leads, so proposals succeed straight away.
 */
export async function startSingleNode(deps: SingleNodeDeps): Promise<Replica> {
  const raftId = deps.raftId ?? 1n;
  const replica = await Replica.open({
    ...deps,
    rangeId: deps.rangeId ?? 1n,
    raftId,
    options: { ...DEFAULT_REPLICA_OPTIONS, ...deps.options },
    transport: SINGLE_NODE_TRANSPORT,
    scheduler: deps.scheduler ?? new SystemScheduler(),
    random: deps.random ?? new SeededRandom(raftId),
    bootstrap: [{ id: raftId, address: '' }],
  });
  replica.start();
  await replica.leaderKnown();
  return replica;
}
