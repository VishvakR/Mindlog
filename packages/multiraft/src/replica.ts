import { create, equals, fromBinary, toBinary } from '@bufbuild/protobuf';
import type {
  Clock,
  Counter,
  Gauge,
  Histogram,
  Logger,
  Metrics,
  MindlogError,
  Random,
  Result,
  SpanAttributes,
  Tracer,
} from '@mindlog/core';
import { err, hlcPhysical, mindlogError, ok } from '@mindlog/core';
import type { Hlc } from '@mindlog/core';
import type {
  Command,
  ConfChange,
  ConfState,
  Entry,
  KeyValue,
  Message,
  RangeDescriptor,
} from '@mindlog/proto';
import {
  CommandSchema,
  ConfChangeSchema,
  ConfChangeType,
  ConfStateSchema,
  EntryType,
  MessageSchema,
  MessageType,
} from '@mindlog/proto';
import type { BootstrapPeer, RaftOptions, RaftStatus, Ready } from '@mindlog/raft';
import { RawNode } from '@mindlog/raft';
import { mergeMembersMatch } from '@mindlog/statemachine';
import type {
  Proposal,
  Proposer,
  RaftLogStore,
  SplitPoint,
  StateMachine,
} from '@mindlog/statemachine';
import type { InboundHandler, RaftTransport, Scheduler } from './ports.js';

/** Replica tunables beyond the Raft core (PLAN 7.4, Appendix B). */
export interface ReplicaOptions extends RaftOptions {
  readonly tickMs: number;
  /** Compact once this many applied entries are in the log. */
  readonly snapshotEntries: number;
  /** Entries kept after compaction so slow followers avoid a snapshot. */
  readonly trailingEntries: number;
  readonly snapshotChunkBytes: number;
  /** Proposals waiting for apply beyond this are refused with BUSY. */
  readonly maxPendingProposals: number;
}

export interface ReplicaDeps {
  readonly rangeId: bigint;
  readonly raftId: bigint;
  readonly options: ReplicaOptions;
  readonly log: RaftLogStore;
  readonly machine: StateMachine;
  readonly transport: RaftTransport;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly random: Random;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly tracer?: Tracer;
  /** While `fenced`, lease reads use ReadIndex: this node's clock is out of line with its peers (ADR-0007). */
  readonly fence?: { readonly fenced: boolean };
  /** Split and merge side effects on the node's other ranges; absent outside a Store. */
  readonly ranges?: RangeEvents;
  /** Initial voters of a brand-new range, written as its state at index 5 (ADR-0028); ignored once it has state. */
  readonly bootstrap?: readonly BootstrapPeer[];
}

/**
 * What a replica asks of its store when a split or merge applies (ADR-0009).
 * Implemented by `Store`.
 */
export interface RangeEvents {
  /** A split created range `rightId`; this node should start its replica. */
  split(rightId: bigint, replicaId: bigint, campaign: boolean): void;
  /** Resolves once the local replica of `rightId` applied `freezeIndex`, then stops it. */
  beforeMerge(rightId: bigint, freezeIndex: bigint): Promise<void>;
  /** The merge applied: the stopped right replica can be destroyed. */
  merged(rightId: bigint): void;
  /** The merge was refused: restart the right replica that `beforeMerge` stopped. */
  mergeAborted(rightId: bigint): void;
  /** This replica was removed from its range: destroy it and refuse its id for good. */
  removed(): void;
  /** The leader applied the removal of another replica, last known at `address`. */
  peerRemoved(replicaId: bigint, address: string): void;
}

/** Read consistency levels (PLAN 9.3, ADR-0007). */
export type ReadLevel = 'linearizable' | 'lease' | 'bounded_staleness';

interface Waiter<T> {
  readonly resolve: (result: Result<T, MindlogError>) => void;
  readonly deadlineTick: bigint;
}

interface PendingProposal extends Waiter<Proposal> {
  readonly started: bigint;
  /** The encoded command, re-proposed when the leader changes (applied once by request id). */
  readonly data: Uint8Array;
}

interface PendingConf extends Waiter<ConfState> {
  readonly index: bigint;
  readonly data: Uint8Array;
}

const ROLE_CODE = { follower: 0, 'pre-candidate': 1, candidate: 2, leader: 3 } as const;
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/**
 * One replica of a range (PLAN 8.2): drives the pure Raft core with the log
 * store, state machine, transport and timers. Each Ready is handled as
 * persist (one fsync) → send → install snapshot / apply in order → advance
 * (CLAUDE.md rule 3). Implements the Proposer port; proposals made on a
 * follower are forwarded by Raft and resolved when this node applies them.
 */
export class Replica implements Proposer, InboundHandler {
  readonly #deps: ReplicaDeps;
  readonly #raw: RawNode;
  readonly #pending = new Map<string, PendingProposal[]>();
  readonly #confWaiters: PendingConf[] = [];
  readonly #readBatch: Array<Waiter<void>> = [];
  readonly #reads = new Map<string, Array<Waiter<void>>>();
  readonly #appliedWaiters: Array<{ index: bigint; done: () => void }> = [];
  readonly #leaderWaiters: Array<() => void> = [];
  readonly #snapshotting = new Set<bigint>();
  #staged: { index: bigint; pairs: readonly KeyValue[] } | undefined;
  #tick = 0n;
  #lastTickNs: bigint;
  #readSeq = 0n;
  #loop: Promise<void> = Promise.resolve();
  #scheduled = false;
  #stopTicks: (() => void) | undefined;
  #failure: unknown;
  #closed = false;
  #autoCampaigned = false;
  /** Leader ticks spent idle; heartbeats ask followers to quiesce while > 0. */
  #idleTicks = 0;
  #quiesced = false;
  #leaderlessTicks = 0;
  #leaseBlockTicks = 0;
  #proposals = 0;
  readonly #labels: { readonly range: string };
  readonly #m: {
    term: Gauge;
    role: Gauge;
    commit: Gauge;
    applied: Gauge;
    elections: Counter;
    commitLatency: Histogram;
    dropped: Counter;
    snapshots: Counter;
  };

  private constructor(deps: ReplicaDeps, raw: RawNode) {
    this.#deps = deps;
    this.#raw = raw;
    this.#lastTickNs = deps.clock.monotonic();
    this.#labels = { range: deps.rangeId.toString() };
    const m = deps.metrics;
    this.#m = {
      term: m.gauge({
        name: 'mindlog_raft_term_count',
        help: 'Current Raft term',
        labelNames: ['range'],
      }),
      role: m.gauge({
        name: 'mindlog_raft_role_info',
        help: '0 follower, 1 pre-candidate, 2 candidate, 3 leader',
        labelNames: ['range'],
      }),
      commit: m.gauge({
        name: 'mindlog_raft_commit_index_entries',
        help: 'Raft commit index',
        labelNames: ['range'],
      }),
      applied: m.gauge({
        name: 'mindlog_raft_applied_index_entries',
        help: 'Last applied log index',
        labelNames: ['range'],
      }),
      elections: m.counter({
        name: 'mindlog_raft_elections_total',
        help: 'Times this node became leader',
        labelNames: ['range'],
      }),
      commitLatency: m.histogram({
        name: 'mindlog_raft_commit_latency_seconds',
        help: 'Proposal to apply on the proposing node',
        buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
        labelNames: ['range'],
      }),
      dropped: m.counter({
        name: 'mindlog_raft_proposals_dropped_total',
        help: 'Proposals that failed before being applied, by reason',
        labelNames: ['range', 'reason'],
      }),
      snapshots: m.counter({
        name: 'mindlog_raft_snapshots_total',
        help: 'Snapshots sent or installed',
        labelNames: ['range', 'direction'],
      }),
    };
  }

  /** Loads the log, reconciles it with the state store (ADR-0026) and builds the core. */
  static async open(deps: ReplicaDeps): Promise<Replica> {
    let stored = await deps.log.load();
    const fresh =
      stored.entries.length === 0 &&
      stored.truncated.index === 0n &&
      deps.machine.applied.index === 0n;
    if (fresh && deps.bootstrap && deps.bootstrap.length > 0) {
      const point = await deps.machine.bootstrap(initialMembers(deps.bootstrap));
      const hardState = { ...stored.hardState, term: point.term, commit: point.index };
      await deps.log.persist({ hardState, entries: [], snapshot: point, sync: true });
      stored = { hardState, truncated: point, entries: [] };
    }
    const applied = deps.machine.applied;
    const last = stored.truncated.index + BigInt(stored.entries.length);
    if (applied.index < stored.truncated.index) {
      throw new Error(
        `state at ${applied.index} is behind the compacted log (${stored.truncated.index})`,
      );
    }
    const termAtApplied =
      applied.index === stored.truncated.index
        ? stored.truncated.term
        : stored.entries[Number(applied.index - stored.truncated.index - 1n)]?.term;
    if (applied.index > last || termAtApplied !== applied.term) {
      // A snapshot was installed but the log rewrite did not finish (ADR-0026).
      deps.logger.warn('resetting the log to the installed snapshot', {
        applied: applied.index,
        last,
      });
      const term = stored.hardState.term > applied.term ? stored.hardState.term : applied.term;
      const commit =
        stored.hardState.commit > applied.index ? stored.hardState.commit : applied.index;
      const hardState = { ...stored.hardState, term, commit };
      await deps.log.persist({ hardState, entries: [], snapshot: applied, sync: true });
      stored = { hardState, truncated: applied, entries: [] };
    }
    const raw = RawNode.create(
      { ...deps.options, id: deps.raftId, rangeId: deps.rangeId, random: deps.random },
      {
        hardState: stored.hardState,
        truncatedIndex: stored.truncated.index,
        truncatedTerm: stored.truncated.term,
        entries: stored.entries,
        applied: applied.index,
        confState: deps.machine.confState,
      },
    );
    await deps.machine.rememberReplicaId(deps.raftId);
    const replica = new Replica(deps, raw);
    deps.transport.attach(replica);
    deps.transport.setPeers(addressesOf(deps.machine.confState));
    return replica;
  }

  /** Starts ticking and processing. */
  start(): void {
    this.#stopTicks = this.#deps.scheduler.every(this.#deps.options.tickMs, () => {
      this.#onTick();
    });
    this.#schedule();
  }

  /** Stops ticking, waits for the current Ready, and fails whatever is pending. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#stopTicks?.();
    await this.#loop;
    this.#failAll(mindlogError('UNAVAILABLE', 'the replica is closed'));
  }

  get failure(): unknown {
    return this.#failure;
  }

  /** Resolves once this node knows a leader (itself or another). */
  leaderKnown(): Promise<void> {
    if (this.#raw.status().lead !== 0n) return Promise.resolve();
    return new Promise((done) => {
      this.#leaderWaiters.push(done);
    });
  }

  /** True while the range is idle and not ticking (ADR-0028). */
  get quiesced(): boolean {
    return this.#quiesced;
  }

  /** Resumes ticking: work arrived, or the store lost contact with the leader's node. */
  wake(): void {
    if (!this.#quiesced && this.#idleTicks === 0) return;
    // The lease counts ticks, and none passed while quiesced: it proves nothing until a
    // heartbeat round echoes fresh ticks (ADR-0007), so reads use ReadIndex meanwhile.
    if (this.#quiesced) this.#leaseBlockTicks = this.#deps.options.electionTicks[0];
    this.#quiesced = false;
    this.#idleTicks = 0;
    this.#schedule();
  }

  /** On a quiesced leader: one round of quiesce heartbeats, so followers keep trusting it. */
  keepalive(): void {
    if (!this.#quiesced || !this.isLeader()) return;
    this.#raw.tick();
    this.#schedule();
  }

  isLeader(): boolean {
    return this.#raw.status().role === 'leader';
  }

  status(): RaftStatus {
    return this.#raw.status();
  }

  get appliedIndex(): bigint {
    return this.#deps.machine.appliedIndex;
  }

  get rangeId(): bigint {
    return this.#deps.rangeId;
  }

  /** True if `id` was removed from this range (ADR-0028). */
  isRemoved(id: bigint): boolean {
    return this.#deps.machine.isRemoved(id);
  }

  /** This replica's Raft id (unique within the range, ADR-0028). */
  get replicaId(): bigint {
    return this.#deps.raftId;
  }

  /** Approximate bytes in the range and proposals accepted so far, for PD's statistics. */
  stats(): { readonly bytes: bigint; readonly proposals: number } {
    return { bytes: this.#deps.machine.approximateBytes, proposals: this.#proposals };
  }

  /** The range this one is frozen for, or 0 (ADR-0009). */
  get frozenFor(): bigint {
    return this.#deps.machine.frozenFor;
  }

  /** False until a bootstrap, split or snapshot gave the replica its state (ADR-0028). */
  get initialised(): boolean {
    return this.#deps.machine.appliedIndex > 0n;
  }

  /** The range's span and epoch as of the applied index. */
  get descriptor(): RangeDescriptor {
    return this.#deps.machine.descriptor;
  }

  /** Where this range would split now (leader side, ADR-0009). */
  findSplitKey(): Promise<SplitPoint | undefined> {
    return this.#deps.machine.findSplitKey();
  }

  /** See `RawNode.forceCommit`: used only when a committed merge needs this replica's last entries. */
  commitUpTo(index: bigint): void {
    this.#raw.forceCommit(index);
    this.#schedule();
  }

  /** Starts an election now (a range just split off a range this node leads). */
  campaign(): void {
    this.#raw.campaign();
    this.#schedule();
  }

  /** Closes the replica and deletes its log (after a merge moved its state away). */
  async destroy(): Promise<void> {
    await this.close();
    await this.#deps.machine.destroyState();
    await this.#deps.log.destroy();
  }

  // ---- Proposer ----

  propose(command: Command): Promise<Result<Proposal, MindlogError>> {
    this.wake();
    const stopped = this.#stopped();
    if (stopped) return Promise.resolve(err(stopped));
    if (this.#pendingCount() >= this.#deps.options.maxPendingProposals) {
      this.#m.dropped.inc(1, { ...this.#labels, reason: 'busy' });
      return Promise.resolve(
        err(mindlogError('BUSY', 'too many pending writes', { retryAfterMs: 10 })),
      );
    }
    const data = toBinary(CommandSchema, command);
    this.#proposals++;
    const proposed = this.#raw.propose(data);
    if (!proposed.ok) {
      this.#m.dropped.inc(1, { ...this.#labels, reason: 'not_leader' });
      return Promise.resolve(proposed);
    }
    return new Promise((resolve) => {
      const key = hex(command.requestId);
      const list = this.#pending.get(key) ?? [];
      list.push({
        resolve,
        deadlineTick: this.#deadline(),
        started: this.#deps.clock.monotonic(),
        data,
      });
      this.#pending.set(key, list);
      this.#schedule();
    });
  }

  // ---- reads (ADR-0007) ----

  /**
   * Resolves once local state may serve a read at `level`: after a ReadIndex
   * round (linearizable), at once within the leader lease (lease), or when
   * the last applied write is recent enough (bounded_staleness).
   */
  read(level: ReadLevel, maxStalenessMs = 500): Promise<Result<void, MindlogError>> {
    this.wake();
    const stopped = this.#stopped();
    if (stopped) return Promise.resolve(err(stopped));
    const machine = this.#deps.machine;
    // A frozen range is about to be merged away: reads here could miss writes the left range takes.
    if (machine.frozenFor !== 0n)
      return Promise.resolve(
        err(mindlogError('RANGE_MOVED', `range ${this.#deps.rangeId} is being merged`)),
      );
    if (level === 'bounded_staleness') {
      const age = this.#deps.clock.now() - hlcPhysical(machine.appliedHlc as Hlc);
      if (machine.appliedHlc > 0n && age <= BigInt(maxStalenessMs))
        return Promise.resolve(ok(undefined));
    }
    if (
      level === 'lease' &&
      this.#tickIsFresh() &&
      this.#leaseBlockTicks === 0 &&
      !this.#deps.fence?.fenced
    ) {
      const index = this.#raw.leaseRead();
      if (index !== undefined) return this.#whenApplied(index).then(() => ok(undefined));
    }
    return new Promise((resolve) => {
      this.#readBatch.push({ resolve, deadlineTick: this.#deadline() });
      this.#schedule();
    });
  }

  // ---- membership and leadership (ADR-0006) ----

  /** Proposes one membership change; resolves with the new ConfState once applied here. */
  changeMembership(cc: ConfChange): Promise<Result<ConfState, MindlogError>> {
    this.wake();
    const stopped = this.#stopped();
    if (stopped) return Promise.resolve(err(stopped));
    const proposed = this.#raw.proposeConfChange(cc);
    if (!proposed.ok) return Promise.resolve(proposed);
    const index = this.#raw.status().lastIndex;
    return new Promise((resolve) => {
      this.#confWaiters.push({
        resolve,
        index,
        data: toBinary(ConfChangeSchema, cc),
        deadlineTick: this.#deadline(),
      });
      this.#schedule();
    });
  }

  transferLeader(to: bigint): Result<void, MindlogError> {
    this.wake();
    const result = this.#raw.transferLeader(to);
    this.#schedule();
    return result;
  }

  // ---- inbound (InboundHandler) ----

  onMessages(messages: readonly Message[]): void {
    if (this.#closed) return;
    for (const m of messages) {
      this.#raw.step(m);
      // Quiesced followers mark their replies, so only a fresh or restarted one wakes the leader.
      if (m.type === MessageType.HEARTBEAT_RESPONSE && m.quiesce) continue;
      const fromLeader = m.type === MessageType.HEARTBEAT && m.from === this.#raw.status().lead;
      if (fromLeader && m.quiesce) this.#quiesced = true;
      else this.wake();
    }
    this.#schedule();
  }

  onSnapshot(message: Message, pairs: readonly KeyValue[]): void {
    if (this.#closed || !message.snapshot) return;
    this.wake();
    this.#staged = { index: message.snapshot.index, pairs };
    this.#raw.step(message);
    this.#schedule();
  }

  onUnreachable(id: bigint): void {
    this.#raw.reportUnreachable(id);
  }

  // ---- the Ready loop ----

  #schedule(): void {
    if (this.#scheduled || this.#failure !== undefined) return;
    this.#scheduled = true;
    this.#deps.scheduler.defer(() => {
      this.#scheduled = false;
      this.#loop = this.#loop.then(() => this.#drain());
    });
  }

  async #drain(): Promise<void> {
    // A drain queued before `close()` must not write state after the replica was destroyed.
    if (this.#failure !== undefined || this.#closed) return;
    try {
      this.#issueReads();
      while (this.#raw.hasReady()) await this.#handle(this.#raw.ready());
      this.#maybeAutoCampaign();
      await this.#maybeCompact();
      if (this.#raw.hasReady()) this.#schedule();
    } catch (cause: unknown) {
      this.#fail(cause);
    }
  }

  async #handle(rd: Ready): Promise<void> {
    if (rd.softState) this.#onSoftState(rd.softState.role, rd.softState.lead);
    if (rd.snapshot) await this.#installSnapshot(rd);
    if (rd.hardState || rd.entries.length > 0 || rd.snapshot) {
      await this.#span('storage.write', { 'mindlog.entries': rd.entries.length }, () =>
        this.#deps.log.persist({
          ...(rd.hardState ? { hardState: rd.hardState } : {}),
          entries: rd.entries,
          ...(rd.snapshot
            ? { snapshot: { index: rd.snapshot.index, term: rd.snapshot.term } }
            : {}),
          sync: rd.mustSync,
        }),
      );
    }
    this.#send(rd.messages);
    for (const entry of rd.committedEntries) await this.#apply(entry);
    for (const rs of rd.readStates) this.#onReadState(rs.index, rs.context);
    this.#raw.advance(rd);
    this.#notifyApplied();
    const s = this.#raw.status();
    if (s.lead !== 0n) for (const done of this.#leaderWaiters.splice(0)) done();
    this.#m.term.set(Number(s.term), this.#labels);
    this.#m.commit.set(Number(s.commit), this.#labels);
    this.#m.applied.set(Number(this.#deps.machine.appliedIndex), this.#labels);
  }

  async #installSnapshot(rd: Ready): Promise<void> {
    const meta = rd.snapshot;
    const staged = this.#staged;
    if (!meta || staged?.index !== meta.index)
      throw new Error(`no data for snapshot at ${meta?.index}`);
    await this.#deps.machine.installSnapshot(meta, staged.pairs);
    this.#staged = undefined;
    this.#deps.transport.setPeers(addressesOf(this.#deps.machine.confState));
    this.#m.snapshots.inc(1, { ...this.#labels, direction: 'installed' });
  }

  async #apply(entry: Entry): Promise<void> {
    const machine = this.#deps.machine;
    if (entry.type === EntryType.CONF_CHANGE) {
      const change = fromBinary(ConfChangeSchema, entry.data);
      const gone = change.type === ConfChangeType.REMOVE_NODE ? change.nodeId : undefined;
      const address =
        gone === undefined ? '' : (machine.confState.addresses[gone.toString()] ?? '');
      const confState = this.#raw.applyConfChange(change);
      await machine.applyConfState(entry.index, entry.term, confState, gone);
      this.#deps.transport.setPeers(addressesOf(confState));
      this.#resolveConf(entry, confState);
      if (gone === this.#deps.raftId) this.#deps.ranges?.removed();
      // The removed replica no longer hears from the leader: tell it, once, that it is gone.
      else if (gone !== undefined && this.isLeader()) this.#deps.ranges?.peerRemoved(gone, address);
      return;
    }
    if (entry.data.length === 0) {
      await machine.applyEmpty(entry.index, entry.term);
      return;
    }
    const command = fromBinary(CommandSchema, entry.data);
    const merge = command.body.case === 'merge' ? command.body.value : undefined;
    if (merge?.right && this.#deps.ranges && mergeMembersMatch(merge, this.#deps.machine.confState))
      await this.#deps.ranges.beforeMerge(merge.right.rangeId, merge.freezeIndex);
    const result = await this.#span(
      'statemachine.apply',
      { 'mindlog.index': entry.index, 'mindlog.body': command.body.case ?? 'none' },
      () => machine.apply(entry.index, entry.term, command),
    );
    await this.#afterRangeCommand(command, result.outcome.case === 'kv');
    const key = hex(command.requestId);
    const waiting = this.#pending.get(key);
    if (!waiting) return;
    this.#pending.delete(key);
    const now = this.#deps.clock.monotonic();
    for (const w of waiting) {
      this.#m.commitLatency.observe(Number(now - w.started) / 1e9, this.#labels);
      w.resolve(ok({ index: entry.index, result }));
    }
  }

  async #afterRangeCommand(command: Command, applied: boolean): Promise<void> {
    const ranges = this.#deps.ranges;
    const body = command.body;
    if (!ranges) return;
    if (body.case === 'split' && applied)
      ranges.split(body.value.newRangeId, this.#deps.raftId, this.isLeader());
    if (body.case !== 'merge' || !body.value.right) return;
    if (!applied) {
      ranges.mergeAborted(body.value.right.rangeId);
      return;
    }
    // The right range's log is deleted next; the merge that replaces it must be durable first.
    await this.#deps.machine.flush();
    ranges.merged(body.value.right.rangeId);
  }

  #resolveConf(entry: Entry, confState: ConfState): void {
    for (let i = this.#confWaiters.length - 1; i >= 0; i--) {
      const w = this.#confWaiters[i];
      if (!w || w.index > entry.index) continue;
      this.#confWaiters.splice(i, 1);
      if (
        w.index === entry.index &&
        equals(
          ConfChangeSchema,
          fromBinary(ConfChangeSchema, w.data),
          fromBinary(ConfChangeSchema, entry.data),
        )
      )
        w.resolve(ok(confState));
      else
        w.resolve(
          err(
            mindlogError('NOT_LEADER', 'leadership changed before the membership change committed'),
          ),
        );
    }
  }

  #send(messages: readonly Message[]): void {
    const regular: Message[] = [];
    const quiesce = this.#quiesced || this.#idleTicks > 0;
    for (const m of messages) {
      if (m.type === MessageType.SNAPSHOT) void this.#sendSnapshot(m);
      else {
        const mark =
          (quiesce && m.type === MessageType.HEARTBEAT) ||
          (this.#quiesced && m.type === MessageType.HEARTBEAT_RESPONSE);
        regular.push(mark ? { ...m, quiesce: true } : m);
      }
    }
    if (regular.length > 0) this.#deps.transport.send(regular);
  }

  async #sendSnapshot(m: Message): Promise<void> {
    if (this.#snapshotting.has(m.to)) return;
    this.#snapshotting.add(m.to);
    let delivered = false;
    try {
      const snapshot = await this.#deps.machine.snapshot();
      try {
        delivered = await this.#deps.transport.sendSnapshot(
          { ...m, snapshot: snapshot.meta },
          snapshot.chunks(this.#deps.options.snapshotChunkBytes),
        );
      } finally {
        await snapshot.release();
      }
      this.#m.snapshots.inc(1, { ...this.#labels, direction: 'sent' });
    } catch (cause: unknown) {
      this.#deps.logger.warn('snapshot send failed', { to: m.to, error: String(cause) });
    } finally {
      this.#snapshotting.delete(m.to);
      this.#raw.reportSnapshot(m.to, delivered);
      this.#schedule();
    }
  }

  // ---- reads ----

  #issueReads(): void {
    if (this.#readBatch.length === 0) return;
    const waiters = this.#readBatch.splice(0);
    this.#readSeq += 1n;
    const context = new Uint8Array(8);
    new DataView(context.buffer).setBigUint64(0, this.#readSeq);
    const issued = this.#raw.readIndex(context);
    if (!issued.ok) {
      for (const w of waiters) w.resolve(issued);
      return;
    }
    this.#reads.set(hex(context), waiters);
  }

  #onReadState(index: bigint, context: Uint8Array): void {
    const key = hex(context);
    const waiters = this.#reads.get(key);
    if (!waiters) return;
    this.#reads.delete(key);
    void this.#whenApplied(index).then(() => {
      for (const w of waiters) w.resolve(ok(undefined));
    });
  }

  #whenApplied(index: bigint): Promise<void> {
    if (this.#deps.machine.appliedIndex >= index) return Promise.resolve();
    return new Promise((done) => {
      this.#appliedWaiters.push({ index, done });
    });
  }

  #notifyApplied(): void {
    const applied = this.#deps.machine.appliedIndex;
    for (let i = this.#appliedWaiters.length - 1; i >= 0; i--) {
      const w = this.#appliedWaiters[i];
      if (w && w.index <= applied) {
        this.#appliedWaiters.splice(i, 1);
        w.done();
      }
    }
  }

  /** Lease reads need a recent tick: a paused process must not trust its lease (ADR-0007). */
  #tickIsFresh(): boolean {
    const elapsed = this.#deps.clock.monotonic() - this.#lastTickNs;
    return elapsed <= BigInt(2 * this.#deps.options.tickMs) * 1_000_000n;
  }

  // ---- ticks, deadlines, compaction ----

  #onTick(): void {
    if (this.#failure !== undefined || this.#closed) return;
    this.#tick += 1n;
    // Waiters still time out while the range is quiesced: leadership may have moved on without them.
    if (this.#quiesced) {
      this.#expire();
      return;
    }
    this.#lastTickNs = this.#deps.clock.monotonic();
    if (this.#leaseBlockTicks > 0) this.#leaseBlockTicks--;
    this.#pokeIfLeaderless();
    this.#idleTicks = this.#canQuiesce() ? this.#idleTicks + 1 : 0;
    // Followers get an election timeout of quiesce heartbeats before the leader goes silent.
    if (this.#idleTicks > this.#deps.options.electionTicks[0]) this.#quiesced = true;
    this.#raw.tick();
    this.#expire();
    this.#schedule();
  }

  /**
   * A follower that has known no leader for an election timeout tells its
   * peers it is here (a heartbeat response without the quiesce mark): a
   * quiesced leader wakes and catches it up. Voters would also campaign, but a
   * learner, or a node that restarted behind a quiesced leader, needs this.
   */
  #pokeIfLeaderless(): void {
    const s = this.#raw.status();
    if (s.role !== 'follower' || s.lead !== 0n) {
      this.#leaderlessTicks = 0;
      return;
    }
    if (++this.#leaderlessTicks < this.#deps.options.electionTicks[0]) return;
    this.#leaderlessTicks = 0;
    const peers = [...s.confState.voters, ...s.confState.learners].filter((id) => id !== s.id);
    if (peers.length === 0) return;
    this.#deps.transport.send(
      peers.map((to) =>
        create(MessageSchema, {
          type: MessageType.HEARTBEAT_RESPONSE,
          from: s.id,
          to,
          term: s.term,
          rangeId: this.#deps.rangeId,
        }),
      ),
    );
  }

  /** A leader may quiesce when nothing is pending and every follower has everything. */
  #canQuiesce(): boolean {
    const s = this.#raw.status();
    if (s.role !== 'leader' || s.leadTransferee !== 0n || s.commit !== s.lastIndex) return false;
    if (this.#deps.machine.appliedIndex !== s.commit || this.#snapshotting.size > 0) return false;
    if (this.#pending.size > 0 || this.#readBatch.length > 0 || this.#reads.size > 0) return false;
    if (this.#confWaiters.length > 0) return false;
    return s.progress.every((p) => p.match === s.lastIndex);
  }

  #deadline(): bigint {
    return this.#tick + BigInt(2 * this.#deps.options.electionTicks[1]);
  }

  /** Fails waiters past their deadline; the write may still commit later (indefinite). */
  #expire(): void {
    const now = this.#tick;
    const late = mindlogError('DEADLINE_EXCEEDED', 'not applied in time; it may still be applied', {
      retryAfterMs: 100,
    });
    for (const [key, list] of this.#pending) {
      const live = list.filter((w) => w.deadlineTick > now);
      for (const w of list) if (w.deadlineTick <= now) w.resolve(err(late));
      if (live.length === 0) this.#pending.delete(key);
      else this.#pending.set(key, live);
      if (live.length < list.length)
        this.#m.dropped.inc(list.length - live.length, { ...this.#labels, reason: 'deadline' });
    }
    const noLeader = mindlogError('NOT_LEADER', 'leadership could not be confirmed in time', {
      retryAfterMs: 100,
    });
    for (const [key, list] of this.#reads) {
      if (list.every((w) => w.deadlineTick > now)) continue;
      this.#reads.delete(key);
      for (const w of list) w.resolve(err(noLeader));
    }
    for (let i = this.#confWaiters.length - 1; i >= 0; i--) {
      const w = this.#confWaiters[i];
      if (w && w.deadlineTick <= now) {
        this.#confWaiters.splice(i, 1);
        w.resolve(err(late));
      }
    }
  }

  /** Flushes state, then drops applied log entries beyond the trailing window (ADR-0005 rule 7). */
  async #maybeCompact(): Promise<void> {
    const options = this.#deps.options;
    const s = this.#raw.status();
    const applied = this.#deps.machine.appliedIndex;
    if (applied - s.firstIndex + 1n <= BigInt(options.snapshotEntries)) return;
    const flushed = await this.#deps.machine.flush();
    const point = flushed.index - BigInt(options.trailingEntries);
    const term = this.#raw.termAt(point);
    if (point < s.firstIndex || term === undefined) return;
    this.#raw.compact(point);
    await this.#deps.log.compact({ index: point, term });
  }

  /** A single-voter range elects itself at once instead of waiting a timeout. */
  #maybeAutoCampaign(): void {
    if (this.#autoCampaigned) return;
    const s = this.#raw.status();
    const voters = s.confState.voters;
    if (
      voters.length === 1 &&
      voters[0] === this.#deps.raftId &&
      s.role === 'follower' &&
      s.applied >= s.commit
    ) {
      this.#autoCampaigned = true;
      this.#raw.campaign();
      this.#schedule();
    }
  }

  #onSoftState(role: RaftStatus['role'], lead: bigint): void {
    this.#m.role.set(ROLE_CODE[role], this.#labels);
    if (role === 'leader') this.#m.elections.inc(1, this.#labels);
    this.#deps.logger.info('raft role changed', { role, lead, term: this.#raw.status().term });
    if (lead !== 0n) this.#reproposePending();
  }

  /**
   * A new leader may never have seen proposals forwarded to the old one.
   * Proposing them again is safe: apply skips a request id it has already
   * applied and returns the stored result (PLAN 6.2).
   */
  #reproposePending(): void {
    for (const list of this.#pending.values()) {
      const first = list[0];
      if (first) this.#raw.propose(first.data);
    }
  }

  // ---- failure ----

  #stopped(): MindlogError | undefined {
    if (this.#failure !== undefined)
      return mindlogError('UNAVAILABLE', 'the replica stopped after a failure');
    if (this.#closed) return mindlogError('UNAVAILABLE', 'the replica is closed');
    return undefined;
  }

  /** Fail-stop: a storage or apply error stops the replica for good (CLAUDE.md rule 6). */
  #fail(cause: unknown): void {
    this.#failure = cause;
    this.#stopTicks?.();
    this.#deps.logger.fatal('replica stopped after a storage or apply failure', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    this.#failAll(mindlogError('UNAVAILABLE', 'the replica stopped after a failure'));
  }

  #failAll(error: MindlogError): void {
    for (const list of this.#pending.values()) for (const w of list) w.resolve(err(error));
    this.#pending.clear();
    for (const w of this.#readBatch.splice(0)) w.resolve(err(error));
    for (const list of this.#reads.values()) for (const w of list) w.resolve(err(error));
    this.#reads.clear();
    for (const w of this.#confWaiters.splice(0)) w.resolve(err(error));
  }

  #pendingCount(): number {
    let n = 0;
    for (const list of this.#pending.values()) n += list.length;
    return n;
  }

  #span<T>(name: string, attributes: SpanAttributes, fn: () => Promise<T>): Promise<T> {
    const tracer = this.#deps.tracer;
    return tracer ? tracer.withSpan(name, attributes, fn) : fn();
  }
}

export function addressesOf(confState: ConfState): Map<bigint, string> {
  return new Map(Object.entries(confState.addresses).map(([id, address]) => [BigInt(id), address]));
}

/** The ConfState of a range's first voters. */
function initialMembers(peers: readonly BootstrapPeer[]): ConfState {
  return create(ConfStateSchema, {
    voters: [...peers].map((p) => p.id).sort((a, b) => (a < b ? -1 : 1)),
    addresses: Object.fromEntries(peers.map((p) => [p.id.toString(), p.address])),
  });
}
