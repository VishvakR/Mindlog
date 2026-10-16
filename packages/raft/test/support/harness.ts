import { create, fromBinary } from '@bufbuild/protobuf';
import { SeededRandom } from '@mindlog/core';
import type { ConfChange, ConfState, Entry, HardState, Message } from '@mindlog/proto';
import {
  ConfChangeSchema,
  ConfStateSchema,
  EntryType,
  HardStateSchema,
  MessageType,
} from '@mindlog/proto';
import type { RaftOptions, Ready } from '@mindlog/raft';
import { DEFAULT_RAFT_OPTIONS, RawNode, bootstrapEntries } from '@mindlog/raft';

/** What one test node has "persisted" and applied. */
export interface TestNode {
  readonly id: bigint;
  raw: RawNode;
  hardState: HardState;
  truncated: { index: bigint; term: bigint };
  entries: Entry[];
  /** Data of applied normal entries, in order (the "state machine"). */
  applied: string[];
  appliedIndex: bigint;
  confState: ConfState;
  readStates: Array<{ index: bigint; context: string }>;
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export interface HarnessOptions extends Partial<RaftOptions> {
  readonly seed?: bigint;
}

/**
 * A synchronous cluster of RawNodes with an in-memory router, in the spirit
 * of etcd's rafttest interaction env: `stabilize()` processes Readies and
 * delivers messages until nothing is left.
 */
export class Harness {
  readonly nodes = new Map<bigint, TestNode>();
  /** Messages waiting for delivery, in send order. */
  inbox: Message[] = [];
  /** Pairs (from→to) whose messages are dropped. */
  readonly cut = new Set<string>();
  readonly delivered: Message[] = [];
  readonly #options: RaftOptions;
  readonly #seed: bigint;

  constructor(options: HarnessOptions = {}) {
    this.#options = { ...DEFAULT_RAFT_OPTIONS, ...options };
    this.#seed = options.seed ?? 1n;
  }

  /** Adds nodes that bootstrap a new range with `ids` as its voters (bootstrapEntries). */
  addNodes(ids: readonly bigint[]): void {
    const entries = bootstrapEntries(ids.map((id) => ({ id, address: `n${id}` })));
    for (const id of ids) {
      this.#boot(id, create(ConfStateSchema, {}), entries);
      this.processReady(id);
    }
  }

  /** Adds a node that starts empty with no configuration (a joiner). */
  addEmptyNode(id: bigint): void {
    this.#boot(id, create(ConfStateSchema, {}));
  }

  node(id: bigint): TestNode {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`no node ${id}`);
    return node;
  }

  /** Simulates a restart: rebuilds the RawNode from what was persisted. */
  restart(id: bigint): void {
    const n = this.node(id);
    n.raw = this.#raw(id, n);
    this.inbox = this.inbox.filter((m) => m.to !== id);
  }

  isolate(id: bigint): void {
    for (const other of this.nodes.keys()) {
      if (other === id) continue;
      this.cut.add(`${id}>${other}`);
      this.cut.add(`${other}>${id}`);
    }
  }

  heal(): void {
    this.cut.clear();
  }

  tick(id: bigint, n = 1): void {
    for (let i = 0; i < n; i++) this.node(id).raw.tick();
  }

  /** Ticks every node `n` times, stabilizing after each round. */
  tickAll(n = 1): void {
    for (let i = 0; i < n; i++) {
      for (const node of this.nodes.values()) node.raw.tick();
      this.stabilize();
    }
  }

  campaign(id: bigint): void {
    this.node(id).raw.campaign();
  }

  propose(id: bigint, data: string): void {
    const result = this.node(id).raw.propose(enc(data));
    if (!result.ok) throw new Error(result.error.message);
  }

  proposeConfChange(id: bigint, cc: Omit<ConfChange, '$typeName'>): void {
    const result = this.node(id).raw.proposeConfChange(create(ConfChangeSchema, cc));
    if (!result.ok) throw new Error(result.error.message);
  }

  leader(): bigint | undefined {
    const leaders = [...this.nodes.values()].filter((n) => n.raw.status().role === 'leader');
    const top = leaders.sort((a, b) => (a.raw.status().term < b.raw.status().term ? 1 : -1))[0];
    return top?.id;
  }

  /** Processes one Ready on `id`: persist, queue messages, apply, advance. */
  processReady(id: bigint): boolean {
    const n = this.node(id);
    if (!n.raw.hasReady()) return false;
    const rd = n.raw.ready();
    this.#persist(n, rd);
    for (const m of rd.messages) this.inbox.push(this.#fillSnapshot(n, m));
    if (rd.snapshot) this.#installSnapshot(n, rd.snapshot.index);
    for (const e of rd.committedEntries) this.#apply(n, e);
    for (const rs of rd.readStates)
      n.readStates.push({ index: rs.index, context: dec(rs.context) });
    n.raw.advance(rd);
    n.raw.checkInvariants();
    return true;
  }

  /** Delivers queued messages once (dropping cut links); returns how many moved. */
  deliver(filter: (m: Message) => boolean = () => true): number {
    const now = this.inbox.filter(filter);
    this.inbox = this.inbox.filter((m) => !filter(m));
    for (const m of now) {
      this.delivered.push(m);
      if (this.cut.has(`${m.from}>${m.to}`)) continue;
      this.nodes.get(m.to)?.raw.step(m);
    }
    return now.length;
  }

  stabilize(limit = 10_000): void {
    for (let round = 0; round < limit; round++) {
      let progressed = false;
      for (const id of this.nodes.keys()) progressed = this.processReady(id) || progressed;
      progressed = this.deliver() > 0 || progressed;
      if (!progressed) return;
    }
    throw new Error('cluster did not stabilize');
  }

  /** Every node's applied data must be a prefix of the longest (state machine safety). */
  checkSafety(): void {
    const logs = [...this.nodes.values()].map((n) => n.applied);
    const longest = logs.reduce((a, b) => (b.length > a.length ? b : a), []);
    for (const log of logs) {
      log.forEach((v, i) => {
        if (longest[i] !== v) throw new Error(`divergent apply at ${i}: ${v} vs ${longest[i]}`);
      });
    }
  }

  #boot(id: bigint, confState: ConfState, entries: Entry[] = []): void {
    const last = BigInt(entries.length);
    const node: TestNode = {
      id,
      raw: undefined as unknown as RawNode,
      hardState: create(HardStateSchema, { term: last > 0n ? 1n : 0n, commit: last }),
      truncated: { index: 0n, term: 0n },
      entries,
      applied: [],
      appliedIndex: 0n,
      confState,
      readStates: [],
    };
    node.raw = this.#raw(id, node);
    this.nodes.set(id, node);
  }

  #raw(id: bigint, n: TestNode): RawNode {
    return RawNode.create(
      { ...this.#options, id, rangeId: 1n, random: new SeededRandom(this.#seed * 1000n + id) },
      {
        hardState: n.hardState,
        truncatedIndex: n.truncated.index,
        truncatedTerm: n.truncated.term,
        entries: n.entries,
        applied: n.appliedIndex,
        confState: n.confState,
      },
    );
  }

  #persist(n: TestNode, rd: Ready): void {
    if (rd.hardState) n.hardState = rd.hardState;
    if (rd.snapshot) {
      n.entries = [];
      n.truncated = { index: rd.snapshot.index, term: rd.snapshot.term };
    }
    const first = rd.entries[0];
    if (first) {
      n.entries = n.entries.filter((e) => e.index < first.index).concat(rd.entries);
    }
  }

  /** Like the real host: send the sender's applied state, labelled with its index and term. */
  #fillSnapshot(n: TestNode, m: Message): Message {
    if (m.type !== MessageType.SNAPSHOT) return m;
    const term = n.raw.termAt(n.appliedIndex) ?? n.truncated.term;
    snapshots.set(`${m.to}@${n.appliedIndex}`, [...n.applied]);
    return {
      ...m,
      snapshot: {
        $typeName: 'mindlog.v1.SnapshotMeta',
        index: n.appliedIndex,
        term,
        confState: n.confState,
      },
    };
  }

  #installSnapshot(n: TestNode, index: bigint): void {
    n.applied = [...(snapshots.get(`${n.id}@${index}`) ?? [])];
    n.appliedIndex = index;
    n.confState = n.raw.status().confState;
  }

  #apply(n: TestNode, e: Entry): void {
    if (e.type === EntryType.CONF_CHANGE) {
      n.confState = n.raw.applyConfChange(fromBinary(ConfChangeSchema, e.data));
    } else if (e.data.length > 0) {
      n.applied.push(dec(e.data));
    }
    n.appliedIndex = e.index;
  }
}

const snapshots = new Map<string, string[]>();

/** Compacts `id`'s log up to its applied index (as the host does after a flush). */
export function compact(h: Harness, id: bigint, upTo?: bigint): void {
  const n = h.node(id);
  const index = upTo ?? n.appliedIndex;
  const term = n.raw.termAt(index);
  if (term === undefined) {
    const st = n.raw.status();
    throw new Error(
      `cannot compact node ${id} at ${index}: raw first ${st.firstIndex} last ${st.lastIndex} applied ${st.applied} commit ${st.commit}, harness truncated ${n.truncated.index}`,
    );
  }
  n.raw.compact(index);
  n.entries = n.entries.filter((e) => e.index > index);
  n.truncated = { index, term };
}
