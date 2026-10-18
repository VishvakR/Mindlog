import type { Clock, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { headerKey } from '@mindlog/kv';
import type { PdClient, Replica } from '@mindlog/multiraft';
import type { KvReply, NodeInfo, RangeDescriptor } from '@mindlog/proto';
import { ReplicaRole } from '@mindlog/proto';
import type { Caller, Placement, RangeCall, RangeRouter, RangeTarget } from '@mindlog/services';
import { SpanReader, inSpan } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import { compareBytes } from '@mindlog/storage';
import type { ForwardCall } from './forward-call.js';

/** The part of the node's `Store` the router reads. */
export interface LocalRanges {
  replicas(): Replica[];
  replica(rangeId: bigint): Replica | undefined;
}

export interface StoreRouterDeps {
  readonly ranges: LocalRanges;
  /** Applied state of every range on this node. */
  readonly state: KvReader;
  /** Absent when the cluster has no placement driver: only local ranges are known. */
  readonly pd?: PdClient;
  /** Nodes PD knows, by id: where a remote leader's internal listener is. */
  readonly nodes: () => ReadonlyMap<bigint, NodeInfo>;
  readonly clock: Clock;
  /** Sends a call to the node at an internal address. */
  readonly send: ForwardCall;
  /** How long a range from PD is trusted before it is read again. */
  readonly cacheTtlMs?: number;
}

interface Cached {
  readonly range: RangeDescriptor;
  readonly leaderReplicaId: bigint;
  readonly at: bigint;
}

const SCAN_PAGE = 256;

/**
 * Finds the range of a key and reaches its leader (ADR-0029). Ranges this node
 * holds are answered from the live replica; others come from a cache of PD's
 * directory that is dropped on `NOT_LEADER` / `RANGE_MOVED` and refilled.
 */
export class StoreRouter implements RangeRouter {
  readonly #d: StoreRouterDeps;
  readonly #cache = new Map<bigint, Cached>();

  constructor(deps: StoreRouterDeps) {
    this.#d = deps;
  }

  async place(
    tenant: string,
    keys: readonly Uint8Array[],
  ): Promise<Result<Placement[], MindlogError>> {
    const out: Placement[] = [];
    for (const key of keys) {
      const placed = await this.#find(headerKey(tenant, key));
      if (!placed.ok) return placed;
      out.push(placed.value);
    }
    return ok(out);
  }

  locate(key: Uint8Array): Promise<Result<Placement, MindlogError>> {
    return this.#find(key);
  }

  async refresh(placement: Placement): Promise<Result<Placement, MindlogError>> {
    this.#cache.delete(placement.rangeId);
    if (!placement.probe) return ok(placement);
    return this.#find(placement.probe);
  }

  forward(
    placement: Placement,
    caller: Caller,
    call: RangeCall,
  ): Promise<Result<KvReply, MindlogError>> {
    // Nothing was sent, so the caller may retry once a leader is known.
    if (!placement.address)
      return Promise.resolve(
        err(mindlogError('NOT_LEADER', `no known leader for range ${placement.rangeId}`)),
      );
    return this.#d.send(placement.address, placement.rangeId, caller, call);
  }

  async ranges(): Promise<Result<Placement[], MindlogError>> {
    const found = new Map<bigint, { range: RangeDescriptor; leaderReplicaId: bigint }>();
    if (this.#d.pd) {
      let start: Uint8Array = new Uint8Array();
      for (;;) {
        const page = await this.#d.pd.scanRanges(start, SCAN_PAGE);
        if (!page.ok) return page;
        for (const range of page.value) found.set(range.rangeId, { range, leaderReplicaId: 0n });
        const last = page.value.at(-1);
        if (page.value.length < SCAN_PAGE || !last || last.endKey.length === 0) break;
        start = last.endKey;
      }
    }
    // The node's own replicas are fresher than PD's view of them.
    for (const r of this.#d.ranges.replicas())
      if (r.initialised && r.rangeId !== 0n)
        found.set(r.rangeId, { range: r.descriptor, leaderReplicaId: 0n });
    const sorted = [...found.values()].sort((a, b) =>
      compareBytes(a.range.startKey, b.range.startKey),
    );
    return ok(sorted.map((e) => this.#placement(e.range, e.leaderReplicaId, e.range.startKey)));
  }

  local(rangeId: bigint): RangeTarget | undefined {
    const replica = this.#d.ranges.replica(rangeId);
    return replica?.initialised ? this.#target(replica) : undefined;
  }

  any(): RangeTarget | undefined {
    const ready = this.#d.ranges.replicas().filter((r) => r.initialised && r.rangeId !== 0n);
    const pick = ready.find((r) => r.isLeader()) ?? ready[0];
    return pick ? this.#target(pick) : undefined;
  }

  #target(replica: Replica): RangeTarget {
    return {
      rangeId: replica.rangeId,
      proposer: replica,
      readBarrier: replica,
      reader: new SpanReader(this.#d.state, replica.descriptor),
      state: this.#d.state,
      descriptor: () => replica.descriptor,
      owns: (tenant, key) => inSpan(replica.descriptor, headerKey(tenant, key)),
      covers: (key) => inSpan(replica.descriptor, key),
    };
  }

  async #find(key: Uint8Array): Promise<Result<Placement, MindlogError>> {
    // shortcut: linear scan of the node's replicas and the cache; switch to a sorted index at ~10k ranges.
    for (const replica of this.#d.ranges.replicas()) {
      if (replica.rangeId === 0n || !replica.initialised || !inSpan(replica.descriptor, key))
        continue;
      return ok(this.#placement(replica.descriptor, replica.status().lead, key, replica));
    }
    const now = this.#d.clock.now();
    const ttl = BigInt(this.#d.cacheTtlMs ?? 5000);
    for (const c of this.#cache.values())
      if (inSpan(c.range, key) && now - c.at < ttl)
        return ok(this.#placement(c.range, c.leaderReplicaId, key));
    if (!this.#d.pd)
      return err(
        mindlogError('RANGE_MOVED', 'no range is known for the key and no placement driver'),
      );
    const found = await this.#d.pd.getRange(key);
    if (!found.ok) return found;
    this.#cache.set(found.value.range.rangeId, { ...found.value, at: now });
    return ok(this.#placement(found.value.range, found.value.leaderReplicaId, key));
  }

  /** `leader` is a raft replica id: the local view's, or PD's. */
  #placement(
    range: RangeDescriptor,
    leader: bigint,
    probe: Uint8Array,
    replica?: Replica,
  ): Placement {
    if (replica?.isLeader()) return { rangeId: range.rangeId, local: this.#target(replica), probe };
    const nodes = this.#d.nodes();
    const addressOf = (r: { replicaId: bigint; nodeId: bigint }): string | undefined =>
      replica?.status().confState.addresses[r.replicaId.toString()] ?? nodes.get(r.nodeId)?.address;
    const members = range.replicas.filter((r) => r.role === ReplicaRole.VOTER);
    const lead = members.find((r) => r.replicaId === leader);
    const fallback = replica
      ? undefined
      : members.find((r) => nodes.get(r.nodeId)?.address !== undefined);
    const address = lead ? addressOf(lead) : fallback ? addressOf(fallback) : undefined;
    // A local follower knows its leader's address from the group's configuration.
    const viaLocal =
      replica && leader !== 0n
        ? replica.status().confState.addresses[leader.toString()]
        : undefined;
    const target = viaLocal ?? address;
    return { rangeId: range.rangeId, probe, ...(target ? { address: target } : {}) };
  }
}
