import type { MessageInitShape } from '@bufbuild/protobuf';
import { create } from '@bufbuild/protobuf';
import type { ConfState, Entry, Message } from '@mindlog/proto';
import {
  ConfStateSchema,
  EntrySchema,
  EntryType,
  MessageSchema,
  MessageType,
} from '@mindlog/proto';
import type { RaftConfig } from './config.js';
import type { RaftLog } from './log/raft-log.js';
import { entrySize } from './log/raft-log.js';
import { quorumValue, voteResult } from './quorum/majority.js';
import type { VoteResult } from './quorum/majority.js';
import type { ReadState } from './read-only.js';
import { ReadOnly } from './read-only.js';
import { NO_LEASE_TICK, Progress } from './tracker/progress.js';

export type Role = 'follower' | 'pre-candidate' | 'candidate' | 'leader';

/** Vote context marking a campaign started by leadership transfer. */
export const TRANSFER_CONTEXT = new Uint8Array([0x74]);

export interface RaftState {
  readonly term: bigint;
  readonly vote: bigint;
  readonly confState: ConfState;
  readonly log: RaftLog;
}

const isTransfer = (context: Uint8Array): boolean =>
  context.length === 1 && context[0] === TRANSFER_CONTEXT[0];

export const voteResponseType = (type: MessageType): MessageType =>
  type === MessageType.PRE_VOTE ? MessageType.PRE_VOTE_RESPONSE : MessageType.VOTE_RESPONSE;

/**
 * One node's Raft state (PLAN 7, modelled on etcd's `raft` struct). Pure and
 * synchronous: inputs are ticks and messages, outputs are queued messages,
 * read states and log changes that RawNode turns into a Ready. Role-specific
 * handling lives in the step-*.ts functions.
 */
export class Raft {
  readonly id: bigint;
  readonly cfg: RaftConfig;
  readonly log: RaftLog;
  term: bigint;
  vote: bigint;
  lead = 0n;
  role: Role = 'follower';
  voters = new Set<bigint>();
  learners = new Set<bigint>();
  addresses = new Map<bigint, string>();
  prs = new Map<bigint, Progress>();
  votes = new Map<bigint, boolean>();
  msgs: Message[] = [];
  readStates: ReadState[] = [];
  readOnly = new ReadOnly();
  /** ReadIndex requests that arrived before an entry of this term committed. */
  pendingReadIndex: Message[] = [];
  electionElapsed = 0;
  heartbeatElapsed = 0;
  randomizedElectionTimeout = 0;
  /** Ticks since start; the leader's lease clock (ADR-0007). */
  tickCount = 0n;
  pendingConfIndex = 0n;
  leadTransferee = 0n;

  constructor(cfg: RaftConfig, state: RaftState) {
    this.id = cfg.id;
    this.cfg = cfg;
    this.log = state.log;
    this.term = state.term;
    this.vote = state.vote;
    this.setConfState(state.confState);
    this.resetRandomizedElectionTimeout();
  }

  // ---- membership ----

  setConfState(cs: ConfState): void {
    this.voters = new Set(cs.voters);
    this.learners = new Set(cs.learners);
    this.addresses = new Map(Object.entries(cs.addresses).map(([id, a]) => [BigInt(id), a]));
    const next = this.log.lastIndex() + 1n;
    const prs = new Map<bigint, Progress>();
    for (const id of [...this.voters, ...this.learners]) {
      prs.set(id, this.prs.get(id) ?? this.newProgress(next, this.learners.has(id)));
      const pr = prs.get(id);
      if (pr) pr.isLearner = this.learners.has(id);
    }
    this.prs = prs;
    const self = this.prs.get(this.id);
    if (self && this.role === 'leader') self.maybeUpdate(this.log.lastIndex());
  }

  confState(): ConfState {
    const addresses: Record<string, string> = {};
    for (const [id, address] of this.addresses) addresses[id.toString()] = address;
    return create(ConfStateSchema, {
      voters: [...this.voters].sort(cmp),
      learners: [...this.learners].sort(cmp),
      addresses,
    });
  }

  newProgress(next: bigint, isLearner: boolean): Progress {
    return new Progress(next, isLearner, this.cfg.maxInflightMsgs, this.cfg.maxInflightBytes);
  }

  promotable(): boolean {
    return this.voters.has(this.id) && this.log.pendingSnapshot === undefined;
  }

  // ---- role transitions ----

  reset(term: bigint): void {
    if (term !== this.term) {
      this.term = term;
      this.vote = 0n;
    }
    this.lead = 0n;
    this.electionElapsed = 0;
    this.heartbeatElapsed = 0;
    this.resetRandomizedElectionTimeout();
    this.leadTransferee = 0n;
    this.votes.clear();
    this.readOnly.reset();
    this.pendingReadIndex = [];
    this.pendingConfIndex = 0n;
    const next = this.log.lastIndex() + 1n;
    for (const [id, pr] of this.prs) {
      const fresh = this.newProgress(next, pr.isLearner);
      if (id === this.id) fresh.match = this.log.lastIndex();
      this.prs.set(id, fresh);
    }
  }

  becomeFollower(term: bigint, lead: bigint): void {
    this.reset(term);
    this.lead = lead;
    this.role = 'follower';
  }

  becomePreCandidate(): void {
    if (this.role === 'leader') throw new Error('leader cannot become pre-candidate');
    // Term and vote stay unchanged until the pre-vote is won.
    this.votes.clear();
    this.lead = 0n;
    this.role = 'pre-candidate';
  }

  becomeCandidate(): void {
    if (this.role === 'leader') throw new Error('leader cannot become candidate');
    this.reset(this.term + 1n);
    this.vote = this.id;
    this.role = 'candidate';
  }

  becomeLeader(): void {
    if (this.role === 'follower') throw new Error('follower cannot become leader');
    this.reset(this.term);
    this.lead = this.id;
    this.role = 'leader';
    for (const [id, pr] of this.prs) {
      if (id !== this.id) pr.recentActive = true;
    }
    // No configuration change until everything up to here is applied (ADR-0006).
    this.pendingConfIndex = this.log.lastIndex();
    this.appendEntries([{ type: EntryType.NORMAL, data: new Uint8Array() }]);
  }

  resetRandomizedElectionTimeout(): void {
    const [min, max] = this.cfg.electionTicks;
    this.randomizedElectionTimeout = min + Math.floor(this.cfg.random.next() * (max - min));
  }

  // ---- outgoing messages ----

  send(fields: MessageInitShape<typeof MessageSchema> & Pick<Message, 'type' | 'to'>): void {
    const m = create(MessageSchema, { from: this.id, rangeId: this.cfg.rangeId, ...fields });
    const local = m.type === MessageType.PROPOSE || m.type === MessageType.READ_INDEX;
    // Votes and their responses set the term explicitly; forwarded requests carry none.
    if (fields.term === undefined && !local) m.term = this.term;
    this.msgs.push(m);
  }

  /** Leader appends new entries at its term and counts its own copy. */
  appendEntries(entries: ReadonlyArray<Pick<Entry, 'type' | 'data'>>): void {
    let index = this.log.lastIndex();
    const stamped = entries.map((e) => {
      index += 1n;
      return create(EntrySchema, { term: this.term, index, type: e.type, data: e.data });
    });
    this.log.append(stamped);
    this.prs.get(this.id)?.maybeUpdate(this.log.lastIndex());
    this.maybeCommit();
  }

  /** Advances the commit index to what a quorum holds, for entries of this term only (§5.4.2). */
  maybeCommit(): boolean {
    const index = quorumValue(this.voters, (id) => this.prs.get(id)?.match ?? 0n);
    if (index <= this.log.committed || this.log.term(index) !== this.term) return false;
    this.log.commitTo(index);
    return true;
  }

  committedEntryInCurrentTerm(): boolean {
    return this.log.term(this.log.committed) === this.term;
  }

  /** Sends the next append (or a snapshot) to `to`; false when nothing went out. */
  sendAppend(to: bigint, sendIfEmpty = true): boolean {
    const pr = this.prs.get(to);
    if (!pr || pr.isPaused()) return false;
    const prevIndex = pr.next - 1n;
    const prevTerm = this.log.term(prevIndex);
    const entries = this.log.slice(pr.next, this.log.lastIndex() + 1n, this.cfg.maxEntryBatchBytes);
    if (prevTerm === undefined || entries === undefined) return this.sendSnapshot(to, pr);
    if (entries.length === 0 && !sendIfEmpty) return false;
    this.send({
      type: MessageType.APPEND,
      to,
      index: prevIndex,
      logTerm: prevTerm,
      entries,
      commit: this.log.committed,
      leaseTick: this.tickCount,
    });
    pr.sentEntries(
      entries.length,
      entries.reduce((n, e) => n + entrySize(e), 0),
    );
    if (this.log.committed > pr.sentCommit) pr.sentCommit = this.log.committed;
    return true;
  }

  /** Asks the host to stream a snapshot; the host fills in the actual metadata. */
  sendSnapshot(to: bigint, pr: Progress): boolean {
    if (!pr.recentActive) return false;
    const index = this.log.truncatedIndex;
    pr.becomeSnapshot(index);
    this.send({
      type: MessageType.SNAPSHOT,
      to,
      snapshot: { index, term: this.log.truncatedTerm, confState: this.confState() },
      leaseTick: this.tickCount,
    });
    return true;
  }

  bcastAppend(): void {
    for (const id of this.prs.keys()) if (id !== this.id) this.sendAppend(id);
  }

  bcastHeartbeat(context?: Uint8Array): void {
    const ctx = context ?? this.readOnly.lastPendingContext() ?? new Uint8Array();
    for (const [id, pr] of this.prs) {
      if (id === this.id) continue;
      const commit = pr.match < this.log.committed ? pr.match : this.log.committed;
      if (commit > pr.sentCommit) pr.sentCommit = commit;
      this.send({
        type: MessageType.HEARTBEAT,
        to: id,
        commit,
        context: ctx,
        leaseTick: this.tickCount,
      });
    }
  }

  // ---- elections ----

  hasUnappliedConfChanges(): boolean {
    for (let i = this.log.applied + 1n; i <= this.log.committed; i++) {
      if (this.log.entry(i)?.type === EntryType.CONF_CHANGE) return true;
    }
    return false;
  }

  poll(id: bigint, granted: boolean): VoteResult {
    if (!this.votes.has(id)) this.votes.set(id, granted);
    return voteResult(this.voters, this.votes);
  }

  isTransferContext(context: Uint8Array): boolean {
    return isTransfer(context);
  }

  /** Followers that heard from a leader recently ignore votes (thesis §4.2.3, ADR-0007). */
  inLease(): boolean {
    return (
      this.cfg.checkQuorum && this.lead !== 0n && this.electionElapsed < this.cfg.electionTicks[0]
    );
  }

  // ---- leases (ADR-0007) ----

  /** True while a quorum has echoed a tick within the last leaseTicks. */
  leaseValid(): boolean {
    if (this.role !== 'leader' || !this.cfg.checkQuorum || !this.committedEntryInCurrentTerm())
      return false;
    const start = quorumValue(this.voters, (id) =>
      id === this.id ? this.tickCount : (this.prs.get(id)?.leaseTick ?? NO_LEASE_TICK),
    );
    return start + BigInt(this.cfg.leaseTicks) > this.tickCount;
  }

  recordLeaseTick(pr: Progress, tick: bigint): void {
    if (tick > pr.leaseTick) pr.leaseTick = tick;
  }

  /** CheckQuorum: did a majority talk to us since the last round? Resets the round. */
  quorumActive(): boolean {
    const votes = new Map<bigint, boolean>();
    for (const [id, pr] of this.prs) {
      if (id === this.id) {
        votes.set(id, true);
        continue;
      }
      if (pr.recentActive) votes.set(id, true);
      pr.recentActive = false;
    }
    return voteResult(this.voters, votes) === 'won';
  }
}

const cmp = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
