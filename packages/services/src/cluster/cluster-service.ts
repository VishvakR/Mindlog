import { create } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError } from '@mindlog/core';
import type { ConfChange, ConfState } from '@mindlog/proto';
import { ConfChangeSchema, ConfChangeType } from '@mindlog/proto';

/** What CLUSTER.INFO reports about this node's range replica. */
export interface ClusterStatus {
  readonly id: bigint;
  readonly term: bigint;
  readonly lead: bigint;
  readonly role: string;
  readonly commit: bigint;
  readonly applied: bigint;
  readonly confState: ConfState;
}

/** Membership and leadership operations of the range replica (ADR-0006); implemented by Replica. */
export interface ClusterAdmin {
  status(): ClusterStatus;
  changeMembership(change: ConfChange): Promise<Result<ConfState, MindlogError>>;
  transferLeader(to: bigint): Result<void, MindlogError>;
}

/**
 * Operator commands for the cluster (CLUSTER.*, PLAN 15.1). Phase 3 has one
 * range per node, so these act on it; the placement driver takes over
 * sequencing in phase 4.
 */
export class ClusterService {
  readonly #admin: ClusterAdmin;

  constructor(admin: ClusterAdmin) {
    this.#admin = admin;
  }

  info(): ClusterStatus {
    return this.#admin.status();
  }

  /** Adds an empty node as a learner; it catches up before it can be promoted. */
  addLearner(nodeId: bigint, address: string): Promise<Result<ConfState, MindlogError>> {
    if (address.trim() === '')
      return Promise.resolve(err(mindlogError('INVALID_ARGUMENT', 'address is required')));
    return this.#change(ConfChangeType.ADD_LEARNER, nodeId, address);
  }

  promote(nodeId: bigint): Promise<Result<ConfState, MindlogError>> {
    return this.#change(ConfChangeType.ADD_VOTER, nodeId, '');
  }

  remove(nodeId: bigint): Promise<Result<ConfState, MindlogError>> {
    return this.#change(ConfChangeType.REMOVE_NODE, nodeId, '');
  }

  transfer(nodeId: bigint): Result<void, MindlogError> {
    return this.#admin.transferLeader(nodeId);
  }

  #change(
    type: ConfChangeType,
    nodeId: bigint,
    address: string,
  ): Promise<Result<ConfState, MindlogError>> {
    if (nodeId < 1n)
      return Promise.resolve(err(mindlogError('INVALID_ARGUMENT', 'node id must be at least 1')));
    return this.#admin.changeMembership(create(ConfChangeSchema, { type, nodeId, address }));
  }
}
