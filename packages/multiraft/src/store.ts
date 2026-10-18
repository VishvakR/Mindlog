import type { MessageInitShape } from '@bufbuild/protobuf';
import { create, fromBinary } from '@bufbuild/protobuf';
import type { Clock, Logger, MindlogError, MindlogErrorCode, Result } from '@mindlog/core';
import { ERROR_CODES, err, mindlogError, ok } from '@mindlog/core';
import type { Command, CommandSchema, KeyValue, Message, RangeDescriptor } from '@mindlog/proto';
import { MessageSchema, MessageType, RangeDescriptorSchema } from '@mindlog/proto';
import type { Proposal } from '@mindlog/statemachine';
import { isUninitialised, rangeDescriptorKey } from '@mindlog/statemachine';
import { compareBytes } from '@mindlog/storage';
import type {
  InboundHandler,
  NodeInboundHandler,
  NodeTransport,
  RaftTransport,
  Scheduler,
} from './ports.js';
import type { RangeEvents, Replica } from './replica.js';

/** What a replica gets from its store instead of its own transport and timers. */
export interface ReplicaViews {
  readonly transport: RaftTransport;
  readonly scheduler: Scheduler;
  readonly ranges: RangeEvents;
}

type CommandBody = NonNullable<MessageInitShape<typeof CommandSchema>['body']>;

/** True if `outer`'s span contains all of `inner`'s. */
function covers(outer: RangeDescriptor, inner: RangeDescriptor): boolean {
  const startOk = compareBytes(outer.startKey, inner.startKey) <= 0;
  const endOk =
    outer.endKey.length === 0 ||
    (inner.endKey.length > 0 && compareBytes(inner.endKey, outer.endKey) <= 0);
  return startOk && endOk;
}

/** True if two descriptors' spans share a key (an empty end key is +infinity). */
function overlaps(a: RangeDescriptor, b: RangeDescriptor): boolean {
  const before = (end: Uint8Array, start: Uint8Array) =>
    end.length > 0 && compareBytes(end, start) <= 0;
  return !before(a.endKey, b.startKey) && !before(b.endKey, a.startKey);
}

export interface StoreDeps {
  readonly nodeId: bigint;
  readonly transport: NodeTransport;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly tickMs: number;
  /** Minimum election timeout in ticks: a quiesced range's leader node must be heard within it. */
  readonly electionTicks: number;
  /** Stamps a range command (request id, HLC) for this node to propose. */
  readonly stamp: (body: CommandBody) => Command;
  /**
   * Opens the local replica of a range (not started). The composition root
   * decides its replica id, stores and whether it bootstraps; a range seen
   * first in a message opens uninitialised and waits for a snapshot.
   */
  readonly openReplica: (
    rangeId: bigint,
    views: ReplicaViews,
    replicaId: bigint | undefined,
  ) => Promise<Replica>;
  /** Removed replicas (`rangeId/replicaId`) loaded at start; messages to them are dropped. */
  readonly tombstones?: ReadonlySet<string>;
  /** Persists a removal so it survives a restart. */
  readonly bury?: (rangeId: bigint, replicaId: bigint) => Promise<void>;
}

/**
 * All replicas of one node (PLAN 8.2, ADR-0028): routes inbound messages by
 * range, resolves replica ids to node addresses, runs one tick timer for every
 * range, creates replicas for ranges first seen in a message, and keeps
 * quiesced ranges safe: their leaders send one keepalive heartbeat per peer
 * node, and followers wake when the leader's node goes quiet.
 */
export class Store implements NodeInboundHandler {
  readonly #deps: StoreDeps;
  readonly #replicas = new Map<bigint, Replica>();
  readonly #opening = new Map<bigint, Promise<Replica>>();
  readonly #handlers = new Map<bigint, InboundHandler>();
  /** Per range: replica id → address, from the applied membership. */
  readonly #members = new Map<bigint, ReadonlyMap<bigint, string>>();
  /** Per range: replica id → address, learned from inbound messages. */
  readonly #learned = new Map<bigint, Map<bigint, string>>();
  readonly #tickers = new Set<() => void>();
  /** Address → tick when anything was last received from it. */
  readonly #heard = new Map<string, bigint>();
  /** Ranges merged away from this node: messages for them never recreate a replica. */
  readonly #gone = new Set<bigint>();
  /** Right-hand replicas stopped for a merge, waiting to be destroyed. */
  readonly #stopped = new Map<bigint, Replica>();
  readonly #frozenTicks = new Map<bigint, number>();
  readonly #tombstones: Set<string>;
  readonly #removing = new Map<bigint, Promise<void>>();
  readonly #tombstoneSent = new Map<string, bigint>();
  /** Left ranges with a merge in flight from this node. */
  readonly #merging = new Set<bigint>();
  #tick = 0n;
  #stopTimer: (() => void) | undefined;
  #closed = false;

  private constructor(deps: StoreDeps) {
    this.#deps = deps;
    this.#tombstones = new Set(deps.tombstones);
  }

  static start(deps: StoreDeps): Store {
    const store = new Store(deps);
    deps.transport.attach(store);
    store.#stopTimer = deps.scheduler.every(deps.tickMs, () => {
      store.#onTick();
    });
    return store;
  }

  /**
   * Opens and starts the replica of `rangeId` (once). A replica created for a
   * message has the id the message is addressed to (ADR-0028).
   */
  addRange(rangeId: bigint, replicaId?: bigint): Promise<Replica> {
    // A replica of this range is still being destroyed; its cleanup would wipe the new one's state.
    const removing = this.#removing.get(rangeId);
    if (removing) return removing.then(() => this.addRange(rangeId, replicaId));
    const open = this.#replicas.get(rangeId);
    if (open) return Promise.resolve(open);
    let opening = this.#opening.get(rangeId);
    if (!opening) {
      opening = this.#deps.openReplica(rangeId, this.#views(rangeId), replicaId).then((replica) => {
        this.#opening.delete(rangeId);
        this.#replicas.set(rangeId, replica);
        if (this.#closed) void replica.close();
        else replica.start();
        return replica;
      });
      this.#opening.set(rangeId, opening);
    }
    return opening;
  }

  /** Destroys this node's replica of a range and refuses its id from now on (PD found it removed). */
  removeReplica(rangeId: bigint): Promise<void> {
    return this.#remove(rangeId);
  }

  replica(rangeId: bigint): Replica | undefined {
    return this.#replicas.get(rangeId);
  }

  replicas(): Replica[] {
    return [...this.#replicas.values()];
  }

  /**
   * Splits `rangeId` at its byte median into a new range `newRangeId` (ADR-0009).
   * Run it on the range's leader; resolves once the split applied here.
   */
  async split(rangeId: bigint, newRangeId: bigint): Promise<Result<void, MindlogError>> {
    const replica = this.#replicas.get(rangeId);
    if (!replica) return err(mindlogError('NOT_FOUND', `this node holds no range ${rangeId}`));
    const point = await replica.findSplitKey();
    if (!point)
      return err(mindlogError('INVALID_ARGUMENT', `range ${rangeId} is too small to split`));
    const proposed = await replica.propose(
      this.#deps.stamp({ case: 'split', value: { ...point, newRangeId } }),
    );
    return this.#outcome(proposed);
  }

  /**
   * Merges the right-hand neighbour of `leftId` into it (ADR-0009). Run it on
   * the right range's leader. It freezes the right range twice: once every
   * member holds the second freeze, each of them also knows the first one is
   * committed, so each can apply it from its own log even after the right
   * range is gone elsewhere. Then it proposes the merge on the left range.
   * Both ranges must have the same members; a failed merge unfreezes again.
   */
  async merge(leftId: bigint): Promise<Result<void, MindlogError>> {
    const left = this.#replicas.get(leftId);
    const end = left?.descriptor.endKey;
    const right = [...this.#replicas.values()].find(
      (r) => end && end.length > 0 && compareBytes(r.descriptor.startKey, end) === 0,
    );
    if (!left || !right) return err(mindlogError('NOT_FOUND', `no right neighbour of ${leftId}`));
    if (!right.isLeader())
      return err(
        mindlogError('NOT_LEADER', `run the merge on the leader of range ${right.rangeId}`),
      );
    if (this.#merging.has(leftId))
      return err(mindlogError('CONFLICT', `range ${leftId} is already merging`));
    this.#merging.add(leftId);
    try {
      return await this.#merge(left, right);
    } finally {
      this.#merging.delete(leftId);
    }
  }

  async #merge(left: Replica, right: Replica): Promise<Result<void, MindlogError>> {
    const leftId = left.rangeId;
    const freezeBody = { case: 'freeze', value: { mergeInto: leftId } } as const;
    const frozen = await right.propose(this.#deps.stamp(freezeBody));
    const freeze = this.#outcome(frozen);
    if (!freeze.ok || !frozen.ok) return freeze;
    const again = await right.propose(this.#deps.stamp(freezeBody));
    const held = again.ok && (await this.#everyMemberHas(right, again.value.index));
    const merged = !held
      ? err(mindlogError('UNAVAILABLE', `not every member of ${right.rangeId} holds the freeze`))
      : this.#outcome(
          await left.propose(
            this.#deps.stamp({
              case: 'merge',
              value: {
                right: right.descriptor,
                freezeIndex: frozen.value.index,
                rightVoters: right.status().confState.voters,
                rightLearners: right.status().confState.learners,
              },
            }),
          ),
        );
    if (!merged.ok && this.#replicas.has(right.rangeId))
      await right.propose(this.#deps.stamp({ case: 'freeze', value: { mergeInto: 0n } }));
    return merged;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#stopTimer?.();
    await Promise.allSettled(this.#opening.values());
    await Promise.all([...this.#replicas.values()].map((r) => r.close()));
  }

  // ---- NodeInboundHandler ----

  onMessages(messages: readonly Message[], from: string): void {
    if (this.#closed) return;
    this.#heard.set(from, this.#tick);
    const byRange = new Map<bigint, Message[]>();
    for (const m of messages) {
      if (m.type === MessageType.TOMBSTONE) {
        const target = this.#replicas.get(m.rangeId);
        if (target?.replicaId === m.to) void this.#remove(m.rangeId);
        continue;
      }
      if (this.#buried(m.rangeId, m.to)) continue;
      const mine = this.#replicas.get(m.rangeId);
      // A replica the range removed is still talking: tell it to stop.
      if (mine?.isRemoved(m.from)) {
        this.#sendTombstone(m.rangeId, mine.replicaId, m.from, from);
        continue;
      }
      if (mine && mine.replicaId !== m.to) {
        // Ids only grow: the group now knows this node by a newer id, so ours was removed without
        // hearing of it. Destroy it; the next message creates the new replica (ADR-0028).
        if (m.to > mine.replicaId) void this.#remove(m.rangeId);
        // Otherwise it is addressed to an earlier incarnation.
        continue;
      }
      this.#learn(m.rangeId, m.from, from);
      const list = byRange.get(m.rangeId) ?? [];
      list.push(m);
      byRange.set(m.rangeId, list);
    }
    for (const [rangeId, list] of byRange) {
      const handler = this.#handlers.get(rangeId);
      if (handler) handler.onMessages(list);
      else if (!this.#gone.has(rangeId))
        void this.#open(rangeId, list[0]?.to).then((h) => h?.onMessages(list));
    }
  }

  onSnapshot(message: Message, pairs: readonly KeyValue[]): void {
    if (this.#closed || this.#gone.has(message.rangeId)) return;
    const overlapped = this.#overlapsLocal(message.rangeId, pairs);
    if (overlapped.length > 0) {
      // A newer snapshot whose span swallows a local range is a merge this node missed:
      // that range is gone. Any other overlap is a split we have not applied yet (ADR-0028).
      const incoming = this.#incoming(pairs, message.rangeId);
      const stale = overlapped.every(
        (r) =>
          incoming !== undefined &&
          covers(incoming, r.replica.descriptor) &&
          (incoming.epoch?.version ?? 0n) > r.descriptorVersion,
      );
      if (!stale) return;
      for (const r of overlapped) void this.#drop(r.replica);
    }
    const handler = this.#handlers.get(message.rangeId);
    if (handler) handler.onSnapshot(message, pairs);
    else void this.#open(message.rangeId).then((h) => h?.onSnapshot(message, pairs));
  }

  onUnreachable(address: string): void {
    for (const [rangeId, handler] of this.#handlers) {
      for (const [id, at] of this.#addresses(rangeId))
        if (at === address) handler.onUnreachable(id);
    }
  }

  // ---- per-range views ----

  #views(rangeId: bigint): ReplicaViews {
    const transport: RaftTransport = {
      attach: (handler) => {
        this.#handlers.set(rangeId, handler);
      },
      send: (messages) => {
        const byAddress = new Map<string, Message[]>();
        for (const m of messages) {
          const address = this.#address(rangeId, m.to);
          if (address === undefined) continue;
          const list = byAddress.get(address) ?? [];
          list.push(m);
          byAddress.set(address, list);
        }
        for (const [address, list] of byAddress) this.#deps.transport.send(address, list);
      },
      sendSnapshot: (message, chunks) => {
        const address = this.#address(rangeId, message.to);
        if (address === undefined) return Promise.resolve(false);
        return this.#deps.transport.sendSnapshot(address, message, chunks);
      },
      setPeers: (addresses) => {
        this.#members.set(rangeId, addresses);
      },
    };
    const scheduler: Scheduler = {
      every: (_ms, fn) => {
        this.#tickers.add(fn);
        return () => {
          this.#tickers.delete(fn);
        };
      },
      defer: (fn) => {
        this.#deps.scheduler.defer(fn);
      },
    };
    const ranges: RangeEvents = {
      split: (rightId, replicaId, campaign) => {
        void this.#startSplit(rightId, replicaId, campaign);
      },
      beforeMerge: (rightId, freezeIndex) => this.#stopForMerge(rightId, freezeIndex),
      mergeAborted: (rightId) => {
        if (!this.#stopped.delete(rightId)) return;
        this.#gone.delete(rightId);
        void this.addRange(rightId);
      },
      removed: () => {
        void this.#remove(rangeId);
      },
      peerRemoved: (replicaId, address) => {
        const replica = this.#replicas.get(rangeId);
        if (replica && address) this.#sendTombstone(rangeId, replica.replicaId, replicaId, address);
      },
      merged: (rightId) => {
        const stopped = this.#stopped.get(rightId);
        this.#stopped.delete(rightId);
        void stopped?.destroy();
      },
    };
    return { transport, scheduler, ranges };
  }

  /** Starts (or restarts an uninitialised) replica of a range this node just split off. */
  async #startSplit(rightId: bigint, replicaId: bigint, campaign: boolean): Promise<void> {
    const existing = this.#replicas.get(rightId);
    if (existing && !existing.initialised) {
      this.#replicas.delete(rightId);
      this.#handlers.delete(rightId);
      await existing.close();
    }
    const replica = await this.addRange(rightId, replicaId);
    if (campaign && replica.initialised) replica.campaign();
  }

  /** Waits for the local right replica to apply the freeze, then stops it (ADR-0009). */
  async #stopForMerge(rightId: bigint, freezeIndex: bigint): Promise<void> {
    // Absent means an earlier merge already folded it in; apply then refuses this one everywhere.
    const right = this.#replicas.get(rightId);
    if (!right || this.#gone.has(rightId)) return;
    // Unbounded on purpose: the merge is committed, so the left range waits for its right half.
    await this.#untilTick(() => {
      // The merge proves the freeze is committed; a follower may not have heard the commit.
      if (right.appliedIndex < freezeIndex) right.commitUpTo(freezeIndex);
      return right.appliedIndex >= freezeIndex || right.failure !== undefined || this.#closed;
    });
    if (right.appliedIndex < freezeIndex) throw new Error(`range ${rightId} stopped`);
    // From here on no message may recreate it: the merge is about to fold it into the left range.
    this.#gone.add(rightId);
    this.#replicas.delete(rightId);
    this.#handlers.delete(rightId);
    this.#stopped.set(rightId, right);
    await right.close();
  }

  /** On the right range's leader, waits (bounded) until every member's log has `index`. */
  async #everyMemberHas(right: Replica, index: bigint): Promise<boolean> {
    const has = () => {
      const s = right.status();
      return s.role === 'leader' && s.progress.every((p) => p.match >= index);
    };
    await this.#untilTick(
      () => has() || right.status().role !== 'leader',
      4 * this.#deps.electionTicks,
    );
    return has();
  }

  /** Resolves on the first store tick where `done()` holds, or after `maxTicks` ticks. */
  #untilTick(done: () => boolean, maxTicks = Number.POSITIVE_INFINITY): Promise<void> {
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      let ticks = 0;
      const check = () => {
        if (done() || ++ticks >= maxTicks) {
          this.#tickers.delete(check);
          resolve();
        }
      };
      this.#tickers.add(check);
    });
  }

  /** A snapshot overlapping another initialised local range waits for a local split (ADR-0028). */
  #overlapsLocal(
    rangeId: bigint,
    pairs: readonly KeyValue[],
  ): Array<{ replica: Replica; descriptorVersion: bigint }> {
    // Range 0 is the placement driver's group: its sliver of keyspace holds no user keys (ADR-0010).
    const incoming = rangeId === 0n ? undefined : this.#incoming(pairs, rangeId);
    if (!incoming) return [];
    const found: Array<{ replica: Replica; descriptorVersion: bigint }> = [];
    for (const [id, replica] of this.#replicas) {
      if (
        id === 0n ||
        id === rangeId ||
        !replica.initialised ||
        isUninitialised(replica.descriptor)
      )
        continue;
      if (overlaps(incoming, replica.descriptor))
        found.push({ replica, descriptorVersion: replica.descriptor.epoch?.version ?? 0n });
    }
    return found;
  }

  #incoming(pairs: readonly KeyValue[], rangeId: bigint): RangeDescriptor | undefined {
    const key = rangeDescriptorKey(rangeId);
    const pair = pairs.find((p) => compareBytes(p.key, key) === 0);
    return pair ? fromBinary(RangeDescriptorSchema, pair.value) : undefined;
  }

  /** At most once per election timeout per removed replica. */
  #sendTombstone(rangeId: bigint, from: bigint, to: bigint, address: string): void {
    const key = `${rangeId}/${to}`;
    const last = this.#tombstoneSent.get(key);
    if (last !== undefined && this.#tick - last < BigInt(this.#deps.electionTicks)) return;
    this.#tombstoneSent.set(key, this.#tick);
    this.#deps.transport.send(address, [
      create(MessageSchema, { type: MessageType.TOMBSTONE, from, to, rangeId }),
    ]);
  }

  #buried(rangeId: bigint, replicaId: bigint): boolean {
    return this.#tombstones.has(`${rangeId}/${replicaId}`);
  }

  /** The replica was removed from its range: stop it, forget its state, and never accept its id again. */
  #remove(rangeId: bigint): Promise<void> {
    const replica = this.#replicas.get(rangeId);
    if (!replica) return Promise.resolve();
    const done = this.#destroy(rangeId, replica)
      .catch((cause: unknown) => {
        // Leftover state of a removed replica is harmless (its id is tombstoned) but worth knowing.
        this.#deps.logger.error('could not finish destroying a replica', {
          rangeId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      })
      .finally(() => {
        this.#removing.delete(rangeId);
      });
    this.#removing.set(rangeId, done);
    return done;
  }

  async #destroy(rangeId: bigint, replica: Replica): Promise<void> {
    this.#tombstones.add(`${rangeId}/${replica.replicaId}`);
    this.#replicas.delete(rangeId);
    this.#handlers.delete(rangeId);
    this.#members.delete(rangeId);
    this.#learned.delete(rangeId);
    await this.#deps.bury?.(rangeId, replica.replicaId);
    await replica.destroy();
  }

  /** Removes a local replica whose range was merged away while this node was behind. */
  async #drop(replica: Replica): Promise<void> {
    const id = replica.rangeId;
    this.#gone.add(id);
    this.#replicas.delete(id);
    this.#handlers.delete(id);
    await replica.destroy();
  }

  #outcome(proposed: Result<Proposal, MindlogError>): Result<void, MindlogError> {
    if (!proposed.ok) return proposed;
    const outcome = proposed.value.result.outcome;
    if (outcome.case !== 'error') return ok(undefined);
    const code =
      outcome.value.code in ERROR_CODES ? (outcome.value.code as MindlogErrorCode) : 'INTERNAL';
    return err(mindlogError(code, outcome.value.message));
  }

  #open(rangeId: bigint, replicaId?: bigint): Promise<InboundHandler | undefined> {
    return this.addRange(rangeId, replicaId).then(
      () => this.#handlers.get(rangeId),
      (cause: unknown) => {
        this.#deps.logger.error('could not open a replica', {
          rangeId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        return undefined;
      },
    );
  }

  #learn(rangeId: bigint, id: bigint, address: string): void {
    if (id === 0n || this.#members.get(rangeId)?.has(id)) return;
    let learned = this.#learned.get(rangeId);
    if (!learned) this.#learned.set(rangeId, (learned = new Map<bigint, string>()));
    learned.set(id, address);
  }

  #address(rangeId: bigint, id: bigint): string | undefined {
    const address = this.#members.get(rangeId)?.get(id) ?? this.#learned.get(rangeId)?.get(id);
    return address === '' ? undefined : address;
  }

  #addresses(rangeId: bigint): Map<bigint, string> {
    return new Map([...(this.#learned.get(rangeId) ?? []), ...(this.#members.get(rangeId) ?? [])]);
  }

  // ---- ticks and quiescence ----

  #onTick(): void {
    if (this.#closed) return;
    this.#tick += 1n;
    for (const fn of this.#tickers) fn();
    this.#keepQuiescedSafe();
    this.#unfreezeStale();
  }

  /**
   * A frozen range whose merge never came (its orchestrator crashed or lost contact)
   * is unfrozen by its leader. Safe at any time: a merge that arrives late finds the
   * range unfrozen and is refused everywhere (ADR-0009).
   */
  #unfreezeStale(): void {
    const limit = 16 * this.#deps.electionTicks;
    for (const [rangeId, replica] of this.#replicas) {
      if (replica.frozenFor === 0n || !replica.isLeader()) {
        this.#frozenTicks.delete(rangeId);
        continue;
      }
      const ticks = (this.#frozenTicks.get(rangeId) ?? 0) + 1;
      this.#frozenTicks.set(rangeId, ticks);
      if (ticks < limit) continue;
      this.#frozenTicks.delete(rangeId);
      void replica
        .propose(this.#deps.stamp({ case: 'freeze', value: { mergeInto: 0n } }))
        .catch(() => undefined);
    }
  }

  /**
   * Quiesced ranges send nothing, so liveness is per node: a quiesced leader
   * sends a keepalive heartbeat to each peer node (one range per node is
   * enough), and a quiesced follower wakes once its leader's node has been
   * silent for an election timeout.
   */
  #keepQuiescedSafe(): void {
    const timeout = BigInt(this.#deps.electionTicks);
    const keepalive = this.#tick % (timeout / 2n > 0n ? timeout / 2n : 1n) === 0n;
    const covered = new Set<string>();
    for (const [rangeId, replica] of this.#replicas) {
      if (!replica.quiesced) continue;
      const status = replica.status();
      if (status.role === 'leader') {
        if (!keepalive) continue;
        const peers = [...status.confState.voters, ...status.confState.learners]
          .filter((id) => id !== status.id)
          .map((id) => this.#address(rangeId, id))
          .filter((a): a is string => a !== undefined);
        if (peers.some((a) => !covered.has(a))) {
          replica.keepalive();
          for (const a of peers) covered.add(a);
        }
        continue;
      }
      const leaderAt = this.#address(rangeId, status.lead);
      const heard = leaderAt === undefined ? undefined : this.#heard.get(leaderAt);
      if (heard === undefined || this.#tick - heard > timeout) replica.wake();
    }
  }
}
