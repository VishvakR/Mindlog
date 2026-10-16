import type { KeyValue, Message } from '@mindlog/proto';

/**
 * Timers for a replica, so the simulator can drive time itself. Production
 * uses `SystemScheduler` (setInterval / setImmediate).
 */
export interface Scheduler {
  /** Calls `fn` every `ms`; returns a function that stops it. */
  every(ms: number, fn: () => void): () => void;
  /** Runs `fn` after the current turn, so work of one turn is batched. */
  defer(fn: () => void): void;
}

/** What a transport delivers to the local replica. */
export interface InboundHandler {
  onMessages(messages: readonly Message[]): void;
  /** A fully received snapshot: the SNAPSHOT message and all its data. */
  onSnapshot(message: Message, pairs: readonly KeyValue[]): void;
  /** Sending to `id` failed; Raft stops pipelining to it. */
  onUnreachable(id: bigint): void;
}

/**
 * Node-to-node Raft messaging (PLAN 7.2, ADR-0025). Best effort: messages may
 * be dropped, duplicated or reordered, and Raft copes. Declared here, where it
 * is used; implemented by @mindlog/transport, the simulator and Maelstrom.
 */
export interface RaftTransport {
  attach(handler: InboundHandler): void;
  send(messages: readonly Message[]): void;
  /** Streams a snapshot; resolves whether it was fully delivered. */
  sendSnapshot(message: Message, chunks: AsyncIterable<KeyValue[]>): Promise<boolean>;
  /** Internal addresses of the range's members, from the applied ConfState. */
  setPeers(addresses: ReadonlyMap<bigint, string>): void;
}
