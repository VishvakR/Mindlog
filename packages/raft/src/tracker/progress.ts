import { Inflights } from './inflights.js';

/** How the leader replicates to one peer (etcd `tracker.StateType`). */
export type ProgressState = 'probe' | 'replicate' | 'snapshot';

/** Lease tick of a peer that has not acknowledged anything this term. */
export const NO_LEASE_TICK = -(2n ** 62n);

/** The leader's view of one peer. */
export class Progress {
  match = 0n;
  next: bigint;
  state: ProgressState = 'probe';
  /** Index of the snapshot being sent, while in `snapshot`. */
  pendingSnapshot = 0n;
  /** Heard from since the last CheckQuorum round. */
  recentActive = false;
  /** Leader ticks spent in `snapshot`; a lost reply must not stall the peer forever. */
  snapshotTicks = 0;
  /** In `probe`: one append is in flight; wait for a reply or heartbeat. */
  probeSent = false;
  /** Highest commit index sent to this peer. */
  sentCommit = 0n;
  /** Latest leader tick this peer echoed (ADR-0007). */
  leaseTick = NO_LEASE_TICK;
  readonly inflights: Inflights;
  isLearner: boolean;

  constructor(next: bigint, isLearner: boolean, maxInflightMsgs: number, maxInflightBytes: number) {
    this.next = next;
    this.isLearner = isLearner;
    this.inflights = new Inflights(maxInflightMsgs, maxInflightBytes);
  }

  becomeProbe(): void {
    if (this.state === 'snapshot') {
      const pending = this.pendingSnapshot;
      this.#reset('probe');
      this.next = (pending > this.match ? pending : this.match) + 1n;
    } else {
      this.#reset('probe');
      this.next = this.match + 1n;
    }
  }

  becomeReplicate(): void {
    this.#reset('replicate');
    this.next = this.match + 1n;
  }

  becomeSnapshot(index: bigint): void {
    this.#reset('snapshot');
    this.pendingSnapshot = index;
  }

  /** On a successful append response; returns whether `match` moved. */
  maybeUpdate(index: bigint): boolean {
    let updated = false;
    if (this.match < index) {
      this.match = index;
      this.probeSent = false;
      updated = true;
    }
    if (this.next < index + 1n) this.next = index + 1n;
    return updated;
  }

  /**
   * On a rejected append for `rejected` with the follower's hint; returns
   * false for a stale rejection that must be ignored.
   */
  maybeDecrTo(rejected: bigint, matchHint: bigint): boolean {
    if (this.state === 'replicate') {
      if (rejected <= this.match) return false;
      this.next = this.match + 1n;
      return true;
    }
    if (this.next - 1n !== rejected) return false;
    const candidate = rejected < matchHint + 1n ? rejected : matchHint + 1n;
    this.next = candidate > this.match + 1n ? candidate : this.match + 1n;
    this.probeSent = false;
    return true;
  }

  isPaused(): boolean {
    if (this.state === 'probe') return this.probeSent;
    if (this.state === 'replicate') return this.inflights.full();
    return true;
  }

  /** Records an append carrying `count` entries of `bytes` total. */
  sentEntries(count: number, bytes: number): void {
    if (this.state === 'replicate' && count > 0) {
      const last = this.next + BigInt(count) - 1n;
      this.inflights.add(last, bytes);
      this.next = last + 1n;
    } else if (this.state === 'probe') {
      this.probeSent = true;
    }
  }

  #reset(state: ProgressState): void {
    this.state = state;
    this.snapshotTicks = 0;
    this.pendingSnapshot = 0n;
    this.probeSent = false;
    this.inflights.reset();
  }
}
