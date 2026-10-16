import { create, toBinary } from '@bufbuild/protobuf';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type {
  ConfChange,
  ConfState,
  Entry,
  HardState,
  Message,
  SnapshotMeta,
} from '@mindlog/proto';
import {
  ConfChangeSchema,
  ConfChangeType,
  ConfStateSchema,
  EntryType,
  HardStateSchema,
  MessageSchema,
  MessageType,
} from '@mindlog/proto';
import type { RaftConfig } from './config.js';
import { hup } from './election.js';
import { RaftLog } from './log/raft-log.js';
import type { Role } from './raft.js';
import { Raft } from './raft.js';
import type { ReadState } from './read-only.js';
import { step } from './step.js';
import { releasePendingReadIndex, sendTimeoutNow } from './step-leader.js';
import type { ProgressState } from './tracker/progress.js';

/** Everything a node loaded from its stores on start (ADR-0026). */
export interface RaftBootState {
  readonly hardState: HardState;
  readonly truncatedIndex: bigint;
  readonly truncatedTerm: bigint;
  readonly entries: readonly Entry[];
  /** Applied index of the state store. */
  readonly applied: bigint;
  readonly confState: ConfState;
}

export interface SoftState {
  readonly lead: bigint;
  readonly role: Role;
}

/**
 * Work for the host (etcd `Ready`): persist `hardState`, `entries` and
 * `snapshot` (fsync when `mustSync`), then send `messages`, then install the
 * snapshot and apply `committedEntries` in order, then call `advance`.
 */
export interface Ready {
  readonly softState?: SoftState;
  readonly hardState?: HardState;
  readonly entries: readonly Entry[];
  readonly snapshot?: SnapshotMeta;
  readonly committedEntries: readonly Entry[];
  readonly messages: readonly Message[];
  readonly readStates: readonly ReadState[];
  readonly mustSync: boolean;
}

export interface PeerStatus {
  readonly id: bigint;
  readonly match: bigint;
  readonly next: bigint;
  readonly state: ProgressState;
  readonly learner: boolean;
  readonly recentActive: boolean;
}

export interface RaftStatus {
  readonly id: bigint;
  readonly term: bigint;
  readonly vote: bigint;
  readonly lead: bigint;
  readonly role: Role;
  readonly commit: bigint;
  readonly applied: bigint;
  readonly firstIndex: bigint;
  readonly lastIndex: bigint;
  readonly confState: ConfState;
  readonly leadTransferee: bigint;
  /** Only on the leader. */
  readonly progress: readonly PeerStatus[];
}

const notLeader = (lead: bigint): MindlogError =>
  mindlogError('NOT_LEADER', lead === 0n ? 'no leader is known' : `the leader is node ${lead}`, {
    retryAfterMs: 100,
    ...(lead === 0n ? {} : { fields: { leader: lead.toString() } }),
  });

/** The host-facing Raft node (etcd `RawNode`): drive it with ticks and messages, drain Readies. */
export class RawNode {
  readonly #r: Raft;
  #prevHard: HardState;
  #prevSoft: SoftState;

  private constructor(cfg: RaftConfig, boot: RaftBootState) {
    const log = new RaftLog({
      truncatedIndex: boot.truncatedIndex,
      truncatedTerm: boot.truncatedTerm,
      entries: boot.entries,
      committed: boot.hardState.commit > boot.applied ? boot.hardState.commit : boot.applied,
      applied: boot.applied,
    });
    this.#r = new Raft(cfg, {
      term: boot.hardState.term,
      vote: boot.hardState.vote,
      confState: boot.confState,
      log,
    });
    this.#prevHard = this.#hardState();
    this.#prevSoft = this.#softState();
  }

  static create(cfg: RaftConfig, boot: RaftBootState): RawNode {
    return new RawNode(cfg, boot);
  }

  get id(): bigint {
    return this.#r.id;
  }

  // ---- inputs ----

  tick(): void {
    const r = this.#r;
    r.tickCount++;
    if (r.role === 'leader') this.#tickHeartbeat();
    else this.#tickElection();
  }

  /** Delivers a message from another node. */
  step(m: Message): void {
    if (m.to !== this.#r.id) return;
    step(this.#r, m);
  }

  /** Starts an election now (single-node bootstrap and tests). */
  campaign(): void {
    hup(this.#r, false);
  }

  propose(data: Uint8Array): Result<void, MindlogError> {
    return this.#propose({ type: EntryType.NORMAL, data });
  }

  /** One single-server change at a time (ADR-0006); only on the leader. */
  proposeConfChange(cc: ConfChange): Result<void, MindlogError> {
    const r = this.#r;
    if (r.role !== 'leader') return err(notLeader(r.lead));
    if (r.pendingConfIndex > r.log.applied)
      return err(mindlogError('CONFLICT', 'a membership change is still in progress'));
    const invalid = validateConfChange(r.confState(), cc);
    if (invalid) return err(mindlogError('INVALID_ARGUMENT', invalid));
    return this.#propose({ type: EntryType.CONF_CHANGE, data: toBinary(ConfChangeSchema, cc) });
  }

  /** Requests a ReadIndex; the result arrives as a ReadState with the same context. */
  readIndex(context: Uint8Array): Result<void, MindlogError> {
    const r = this.#r;
    if (r.role !== 'leader' && r.lead === 0n) return err(notLeader(0n));
    step(r, create(MessageSchema, { type: MessageType.READ_INDEX, from: r.id, to: r.id, context }));
    return ok(undefined);
  }

  /** Commit index if the leader lease holds (ADR-0007), else undefined. */
  leaseRead(): bigint | undefined {
    return this.#r.leaseValid() ? this.#r.log.committed : undefined;
  }

  transferLeader(to: bigint): Result<void, MindlogError> {
    const r = this.#r;
    if (r.role !== 'leader') return err(notLeader(r.lead));
    if (to === r.id) return ok(undefined);
    const pr = r.prs.get(to);
    if (!pr || !r.voters.has(to))
      return err(mindlogError('INVALID_ARGUMENT', `node ${to} is not a voter`));
    if (r.leadTransferee === to) return ok(undefined);
    r.leadTransferee = to;
    r.electionElapsed = 0;
    if (pr.match === r.log.lastIndex()) sendTimeoutNow(r, to);
    else r.sendAppend(to);
    return ok(undefined);
  }

  /** The transport could not reach `id`: stop pipelining to it. */
  reportUnreachable(id: bigint): void {
    const pr = this.#r.prs.get(id);
    if (this.#r.role === 'leader' && pr?.state === 'replicate') pr.becomeProbe();
  }

  /**
   * The transport finished streaming a snapshot to `id` (or failed): probe
   * again after the next heartbeat; the follower's reply moves it on.
   */
  reportSnapshot(id: bigint, _ok: boolean): void {
    const pr = this.#r.prs.get(id);
    if (this.#r.role !== 'leader' || pr?.state !== 'snapshot') return;
    pr.becomeProbe();
    pr.probeSent = true;
  }

  /** Applies a committed membership change (call in apply order). */
  applyConfChange(cc: ConfChange): ConfState {
    const r = this.#r;
    const next = applyToConfState(r.confState(), cc);
    r.setConfState(next);
    if (r.role === 'leader') {
      if (!r.voters.has(r.id)) {
        r.becomeFollower(r.term, 0n);
      } else {
        if (r.leadTransferee !== 0n && !r.voters.has(r.leadTransferee)) r.leadTransferee = 0n;
        if (r.maybeCommit()) releasePendingReadIndex(r);
        r.bcastAppend();
      }
    }
    return next;
  }

  /** Drops log entries up to `index` (applied and flushed by the host). */
  compact(index: bigint): void {
    this.#r.log.compact(index);
  }

  termAt(index: bigint): bigint | undefined {
    return this.#r.log.term(index);
  }

  // ---- Ready / advance ----

  hasReady(): boolean {
    const r = this.#r;
    return (
      r.msgs.length > 0 ||
      r.readStates.length > 0 ||
      r.log.pendingSnapshot !== undefined ||
      r.log.lastIndex() > r.log.stabled ||
      r.log.hasNextCommitted() ||
      !sameHard(this.#hardState(), this.#prevHard) ||
      !sameSoft(this.#softState(), this.#prevSoft)
    );
  }

  ready(): Ready {
    const r = this.#r;
    const hard = this.#hardState();
    const soft = this.#softState();
    const entries = r.log.unstableEntries();
    const snapshot = r.log.pendingSnapshot;
    const committedEntries = r.log.nextCommittedEntries();
    const last = committedEntries.at(-1);
    if (last) r.log.applying = last.index;
    const hardChanged = !sameHard(hard, this.#prevHard);
    const rd: Ready = {
      ...(sameSoft(soft, this.#prevSoft) ? {} : { softState: soft }),
      ...(hardChanged ? { hardState: hard } : {}),
      entries,
      ...(snapshot ? { snapshot } : {}),
      committedEntries,
      messages: r.msgs,
      readStates: r.readStates,
      mustSync:
        entries.length > 0 ||
        snapshot !== undefined ||
        hard.term !== this.#prevHard.term ||
        hard.vote !== this.#prevHard.vote,
    };
    r.msgs = [];
    r.readStates = [];
    this.#prevHard = hard;
    this.#prevSoft = soft;
    return rd;
  }

  /** Acknowledges a Ready after its entries are persisted and its committed entries applied. */
  advance(rd: Ready): void {
    const r = this.#r;
    const lastEntry = rd.entries.at(-1);
    if (lastEntry) r.log.stableTo(lastEntry.index, lastEntry.term);
    if (rd.snapshot) r.log.snapshotInstalled(rd.snapshot.index);
    const lastApplied = rd.committedEntries.at(-1);
    if (lastApplied) r.log.appliedTo(lastApplied.index);
  }

  // ---- inspection ----

  status(): RaftStatus {
    const r = this.#r;
    const progress: PeerStatus[] =
      r.role === 'leader'
        ? [...r.prs].map(([id, pr]) => ({
            id,
            match: pr.match,
            next: pr.next,
            state: pr.state,
            learner: pr.isLearner,
            recentActive: pr.recentActive,
          }))
        : [];
    return {
      id: r.id,
      term: r.term,
      vote: r.vote,
      lead: r.lead,
      role: r.role,
      commit: r.log.committed,
      applied: r.log.applied,
      firstIndex: r.log.firstIndex(),
      lastIndex: r.log.lastIndex(),
      confState: r.confState(),
      leadTransferee: r.leadTransferee,
      progress,
    };
  }

  /** Local invariants of PLAN 7.5 (6); throws when broken. Cheap; run in debug and the simulator. */
  checkInvariants(): void {
    const log = this.#r.log;
    if (log.applied > log.committed)
      throw new Error(`applied ${log.applied} > commit ${log.committed}`);
    if (log.committed > log.lastIndex())
      throw new Error(`commit ${log.committed} > last ${log.lastIndex()}`);
    if (log.applied < log.truncatedIndex)
      throw new Error(`applied ${log.applied} < truncated ${log.truncatedIndex}`);
  }

  // ---- internals ----

  #propose(entry: Pick<Entry, 'type' | 'data'>): Result<void, MindlogError> {
    const r = this.#r;
    if (r.role === 'leader') {
      if (r.leadTransferee !== 0n)
        return err(
          mindlogError('NOT_LEADER', 'leadership transfer in progress', { retryAfterMs: 100 }),
        );
    } else if (r.role !== 'follower' || r.lead === 0n) {
      return err(notLeader(r.lead));
    }
    step(
      r,
      create(MessageSchema, {
        type: MessageType.PROPOSE,
        from: r.id,
        to: r.id,
        entries: [{ type: entry.type, data: entry.data }],
      }),
    );
    return ok(undefined);
  }

  #tickElection(): void {
    const r = this.#r;
    r.electionElapsed++;
    if (r.promotable() && r.electionElapsed >= r.randomizedElectionTimeout) {
      r.electionElapsed = 0;
      hup(r, false);
    }
  }

  #tickHeartbeat(): void {
    const r = this.#r;
    r.heartbeatElapsed++;
    r.electionElapsed++;
    if (r.electionElapsed >= r.cfg.electionTicks[0]) {
      r.electionElapsed = 0;
      if (r.cfg.checkQuorum && !r.quorumActive()) {
        r.becomeFollower(r.term, 0n);
        return;
      }
      r.leadTransferee = 0n;
    }
    for (const pr of r.prs.values()) {
      if (pr.state === 'snapshot' && ++pr.snapshotTicks >= 2 * r.cfg.electionTicks[1])
        pr.becomeProbe();
    }
    if (r.heartbeatElapsed >= r.cfg.heartbeatTicks) {
      r.heartbeatElapsed = 0;
      r.bcastHeartbeat();
    }
  }

  #hardState(): HardState {
    const r = this.#r;
    return create(HardStateSchema, { term: r.term, vote: r.vote, commit: r.log.committed });
  }

  #softState(): SoftState {
    return { lead: this.#r.lead, role: this.#r.role };
  }
}

const sameHard = (a: HardState, b: HardState): boolean =>
  a.term === b.term && a.vote === b.vote && a.commit === b.commit;

const sameSoft = (a: SoftState, b: SoftState): boolean => a.lead === b.lead && a.role === b.role;

/** Why a change cannot be proposed against `cs`, or undefined when it can. */
export function validateConfChange(cs: ConfState, cc: ConfChange): string | undefined {
  if (cc.nodeId === 0n) return 'node id must be non-zero';
  const voter = cs.voters.includes(cc.nodeId);
  const learner = cs.learners.includes(cc.nodeId);
  switch (cc.type) {
    case ConfChangeType.ADD_LEARNER:
      if (voter) return `node ${cc.nodeId} is already a voter`;
      if (learner) return `node ${cc.nodeId} is already a learner`;
      return cc.address ? undefined : 'a new node needs an address';
    case ConfChangeType.ADD_VOTER:
      if (voter) return `node ${cc.nodeId} is already a voter`;
      return learner || cc.address ? undefined : 'a new node needs an address';
    case ConfChangeType.REMOVE_NODE:
      if (!voter && !learner) return `node ${cc.nodeId} is not a member`;
      return voter && cs.voters.length === 1 ? 'cannot remove the last voter' : undefined;
    default:
      return 'unknown change type';
  }
}

/** Deterministic result of applying `cc` to `cs`; invalid changes leave it unchanged. */
export function applyToConfState(cs: ConfState, cc: ConfChange): ConfState {
  const next = {
    voters: new Set(cs.voters),
    learners: new Set(cs.learners),
    addresses: new Map(Object.entries(cs.addresses)),
  };
  if (validateConfChange(cs, cc) === undefined) {
    const key = cc.nodeId.toString();
    if (cc.type === ConfChangeType.ADD_LEARNER) next.learners.add(cc.nodeId);
    if (cc.type === ConfChangeType.ADD_VOTER) {
      next.learners.delete(cc.nodeId);
      next.voters.add(cc.nodeId);
    }
    if (cc.type === ConfChangeType.REMOVE_NODE) {
      next.voters.delete(cc.nodeId);
      next.learners.delete(cc.nodeId);
      next.addresses.delete(key);
    } else if (cc.address) {
      next.addresses.set(key, cc.address);
    }
  }
  const order = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
  return create(ConfStateSchema, {
    voters: [...next.voters].sort(order),
    learners: [...next.learners].sort(order),
    addresses: Object.fromEntries(next.addresses),
  });
}
