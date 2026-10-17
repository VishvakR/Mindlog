import type { Clock, Logger } from '@mindlog/core';
import type { KeyValue, Message } from '@mindlog/proto';
import type {
  InboundHandler,
  NodeInboundHandler,
  NodeTransport,
  RaftTransport,
  Scheduler,
} from './ports.js';
import type { Replica } from './replica.js';

/** What a replica gets from its store instead of its own transport and timers. */
export interface ReplicaViews {
  readonly transport: RaftTransport;
  readonly scheduler: Scheduler;
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
  /**
   * Opens the local replica of a range (not started). The composition root
   * decides its replica id, stores and whether it bootstraps; a range seen
   * first in a message opens uninitialised and waits for a snapshot.
   */
  readonly openReplica: (rangeId: bigint, views: ReplicaViews) => Promise<Replica>;
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
  #tick = 0n;
  #stopTimer: (() => void) | undefined;
  #closed = false;

  private constructor(deps: StoreDeps) {
    this.#deps = deps;
  }

  static start(deps: StoreDeps): Store {
    const store = new Store(deps);
    deps.transport.attach(store);
    store.#stopTimer = deps.scheduler.every(deps.tickMs, () => {
      store.#onTick();
    });
    return store;
  }

  /** Opens and starts the replica of `rangeId` (once). */
  addRange(rangeId: bigint): Promise<Replica> {
    const open = this.#replicas.get(rangeId);
    if (open) return Promise.resolve(open);
    let opening = this.#opening.get(rangeId);
    if (!opening) {
      opening = this.#deps.openReplica(rangeId, this.#views(rangeId)).then((replica) => {
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

  replica(rangeId: bigint): Replica | undefined {
    return this.#replicas.get(rangeId);
  }

  replicas(): Replica[] {
    return [...this.#replicas.values()];
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
      this.#learn(m.rangeId, m.from, from);
      const list = byRange.get(m.rangeId) ?? [];
      list.push(m);
      byRange.set(m.rangeId, list);
    }
    for (const [rangeId, list] of byRange) {
      const handler = this.#handlers.get(rangeId);
      if (handler) handler.onMessages(list);
      else void this.#open(rangeId).then((h) => h?.onMessages(list));
    }
  }

  onSnapshot(message: Message, pairs: readonly KeyValue[]): void {
    if (this.#closed) return;
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
    return { transport, scheduler };
  }

  #open(rangeId: bigint): Promise<InboundHandler | undefined> {
    return this.addRange(rangeId).then(
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
