import type { Entry, SnapshotMeta } from '@mindlog/proto';

/** What a node loads from its log store on start (ADR-0026). */
export interface LogState {
  readonly truncatedIndex: bigint;
  readonly truncatedTerm: bigint;
  /** Entries after the truncated index, contiguous. */
  readonly entries: readonly Entry[];
  readonly committed: bigint;
  readonly applied: bigint;
}

/** Bytes an entry adds to a message, for batching and flow control. */
export const entrySize = (entry: Entry): number => entry.data.length + 24;

/**
 * In-memory view of a range's log: everything after the truncated point, plus
 * how far it is persisted (`stabled`), committed, handed out for apply
 * (`applying`) and applied. Synchronous, so the core never awaits.
 *
 * shortcut: the whole uncompacted log stays in memory, bounded by
 * raft.snapshotEntries/snapshotBytes; switch to an async entry cache when one
 * node hosts many ranges (phase 4).
 */
export class RaftLog {
  #truncatedIndex: bigint;
  #truncatedTerm: bigint;
  #entries: Entry[];
  stabled: bigint;
  committed: bigint;
  applying: bigint;
  applied: bigint;
  /** A snapshot received from the leader, not yet installed by the host. */
  pendingSnapshot: SnapshotMeta | undefined;

  constructor(state: LogState) {
    this.#truncatedIndex = state.truncatedIndex;
    this.#truncatedTerm = state.truncatedTerm;
    this.#entries = [...state.entries];
    this.stabled = this.lastIndex();
    if (state.applied < state.truncatedIndex || state.committed < state.applied)
      throw new Error(
        `inconsistent log state: truncated ${state.truncatedIndex}, applied ${state.applied}, committed ${state.committed}`,
      );
    this.committed = state.committed < this.lastIndex() ? state.committed : this.lastIndex();
    this.applied = state.applied;
    this.applying = state.applied;
  }

  get truncatedIndex(): bigint {
    return this.#truncatedIndex;
  }

  get truncatedTerm(): bigint {
    return this.#truncatedTerm;
  }

  firstIndex(): bigint {
    return this.#truncatedIndex + 1n;
  }

  lastIndex(): bigint {
    return this.#truncatedIndex + BigInt(this.#entries.length);
  }

  lastTerm(): bigint {
    return this.term(this.lastIndex()) ?? 0n;
  }

  /** Term of the entry at `index`, or undefined when compacted or not yet written. */
  term(index: bigint): bigint | undefined {
    if (index === this.#truncatedIndex) return this.#truncatedTerm;
    if (index < this.#truncatedIndex || index > this.lastIndex()) return undefined;
    return this.#entries[Number(index - this.#truncatedIndex - 1n)]?.term;
  }

  matchTerm(index: bigint, term: bigint): boolean {
    return this.term(index) === term;
  }

  /** Raft §5.4.1: is a log ending at (index, term) at least as up to date as ours? */
  isUpToDate(index: bigint, term: bigint): boolean {
    const lastTerm = this.lastTerm();
    return term > lastTerm || (term === lastTerm && index >= this.lastIndex());
  }

  entry(index: bigint): Entry | undefined {
    if (index <= this.#truncatedIndex) return undefined;
    return this.#entries[Number(index - this.#truncatedIndex - 1n)];
  }

  /**
   * Entries in [lo, hi), at most `maxBytes` (but at least one). Undefined when
   * `lo` is compacted, so the caller must send a snapshot.
   */
  slice(lo: bigint, hi: bigint, maxBytes = Number.POSITIVE_INFINITY): Entry[] | undefined {
    if (lo <= this.#truncatedIndex) return undefined;
    const end = hi > this.lastIndex() + 1n ? this.lastIndex() + 1n : hi;
    const out: Entry[] = [];
    let bytes = 0;
    for (let i = lo; i < end; i++) {
      const entry = this.entry(i);
      if (!entry) break;
      bytes += entrySize(entry);
      if (out.length > 0 && bytes > maxBytes) break;
      out.push(entry);
    }
    return out;
  }

  /** Appends contiguous entries, replacing any suffix from their first index. */
  append(entries: readonly Entry[]): bigint {
    const first = entries[0];
    if (!first) return this.lastIndex();
    const after = first.index - 1n;
    if (after < this.committed)
      throw new Error(`append at ${first.index} would overwrite committed ${this.committed}`);
    if (after > this.lastIndex())
      throw new Error(`append at ${first.index} leaves a gap after ${this.lastIndex()}`);
    this.#entries.length = Number(after - this.#truncatedIndex);
    this.#entries.push(...entries);
    if (this.stabled > after) this.stabled = after;
    return this.lastIndex();
  }

  /** First index whose term differs from ours (or that we lack); 0 if all match. */
  findConflict(entries: readonly Entry[]): bigint {
    for (const entry of entries) {
      if (!this.matchTerm(entry.index, entry.term)) return entry.index;
    }
    return 0n;
  }

  /**
   * Largest index <= `index` whose term is <= `term`, with that term: the
   * fast-backtracking hint for a rejected append.
   */
  findConflictByTerm(index: bigint, term: bigint): readonly [bigint, bigint] {
    let i = index > this.lastIndex() ? this.lastIndex() : index;
    for (; i > this.#truncatedIndex; i--) {
      const t = this.term(i) ?? 0n;
      if (t <= term) return [i, t];
    }
    return [this.#truncatedIndex, this.#truncatedTerm];
  }

  /** Follower side of AppendEntries; returns the last new index, or undefined on mismatch. */
  maybeAppend(
    prevIndex: bigint,
    prevTerm: bigint,
    commit: bigint,
    entries: readonly Entry[],
  ): bigint | undefined {
    if (!this.matchTerm(prevIndex, prevTerm)) return undefined;
    const lastNew = prevIndex + BigInt(entries.length);
    const conflict = this.findConflict(entries);
    if (conflict !== 0n) this.append(entries.slice(Number(conflict - prevIndex - 1n)));
    this.commitTo(commit < lastNew ? commit : lastNew);
    return lastNew;
  }

  commitTo(index: bigint): void {
    if (index <= this.committed) return;
    if (index > this.lastIndex())
      throw new Error(`commit ${index} is beyond the last index ${this.lastIndex()}`);
    this.committed = index;
  }

  unstableEntries(): Entry[] {
    return this.slice(this.stabled + 1n, this.lastIndex() + 1n) ?? [];
  }

  hasNextCommitted(): boolean {
    return this.pendingSnapshot === undefined && this.committed > this.applying;
  }

  nextCommittedEntries(): Entry[] {
    if (!this.hasNextCommitted()) return [];
    return this.slice(this.applying + 1n, this.committed + 1n) ?? [];
  }

  stableTo(index: bigint, term: bigint): void {
    // A later append may have replaced the entry while it was being persisted.
    if (this.matchTerm(index, term) && index > this.stabled) this.stabled = index;
  }

  appliedTo(index: bigint): void {
    if (index > this.committed)
      throw new Error(`applied ${index} is beyond commit ${this.committed}`);
    if (index > this.applied) this.applied = index;
    if (index > this.applying) this.applying = index;
  }

  /** Replaces the log with a snapshot received from the leader. */
  restore(meta: SnapshotMeta): void {
    this.#entries = [];
    this.#truncatedIndex = meta.index;
    this.#truncatedTerm = meta.term;
    this.stabled = meta.index;
    this.committed = meta.index;
    this.applying = meta.index;
    this.pendingSnapshot = meta;
  }

  snapshotInstalled(index: bigint): void {
    if (this.pendingSnapshot?.index === index) this.pendingSnapshot = undefined;
    if (index > this.applied) this.applied = index;
  }

  /** Drops entries up to `index` (which must be applied), keeping its term. */
  compact(index: bigint): void {
    if (index <= this.#truncatedIndex) return;
    if (index > this.applied) throw new Error(`compact ${index} is beyond applied ${this.applied}`);
    const term = this.term(index);
    if (term === undefined) throw new Error(`compact ${index}: entry missing`);
    this.#entries = this.#entries.slice(Number(index - this.#truncatedIndex));
    this.#truncatedIndex = index;
    this.#truncatedTerm = term;
  }
}
