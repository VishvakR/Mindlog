/** A ReadIndex result: reads tagged `context` may be served once applied >= `index`. */
export interface ReadState {
  readonly index: bigint;
  readonly context: Uint8Array;
}

interface PendingRead {
  readonly index: bigint;
  readonly context: Uint8Array;
  /** Requesting node; the leader itself for local reads. */
  readonly from: bigint;
  readonly acks: Map<bigint, boolean>;
}

const keyOf = (context: Uint8Array): string => Buffer.from(context).toString('hex');

/**
 * Leader-side queue of ReadIndex requests waiting for a heartbeat round to
 * confirm leadership (Raft thesis §6.4). Requests are released in order, so an
 * ack for a later request also confirms every earlier one.
 */
export class ReadOnly {
  #pending = new Map<string, PendingRead>();
  #queue: string[] = [];

  add(index: bigint, context: Uint8Array, from: bigint): void {
    const key = keyOf(context);
    if (this.#pending.has(key)) return;
    this.#pending.set(key, { index, context, from, acks: new Map() });
    this.#queue.push(key);
  }

  /** Records a heartbeat ack; returns the acks so far, or undefined if unknown. */
  recvAck(id: bigint, context: Uint8Array): ReadonlyMap<bigint, boolean> | undefined {
    const pending = this.#pending.get(keyOf(context));
    if (!pending) return undefined;
    pending.acks.set(id, true);
    return pending.acks;
  }

  /** Removes and returns every request up to and including `context`. */
  advance(context: Uint8Array): Array<Omit<PendingRead, 'acks'>> {
    const at = this.#queue.indexOf(keyOf(context));
    if (at < 0) return [];
    const released = this.#queue.splice(0, at + 1);
    return released.flatMap((key) => {
      const read = this.#pending.get(key);
      this.#pending.delete(key);
      return read ? [{ index: read.index, context: read.context, from: read.from }] : [];
    });
  }

  lastPendingContext(): Uint8Array | undefined {
    const key = this.#queue.at(-1);
    return key === undefined ? undefined : this.#pending.get(key)?.context;
  }

  get size(): number {
    return this.#queue.length;
  }

  reset(): void {
    this.#pending.clear();
    this.#queue = [];
  }
}
