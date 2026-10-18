import type { MindlogError, Result } from '@mindlog/core';
import type { Command, KvReply, RangeDescriptor } from '@mindlog/proto';
import type { Proposer } from '@mindlog/statemachine';
import type { KvReader } from '@mindlog/storage';
import type { ReadBarrier } from './read-barrier.js';

/** This node's replica of a range, as the request path uses it. */
export interface RangeTarget {
  readonly rangeId: bigint;
  readonly proposer: Proposer;
  readonly readBarrier: ReadBarrier;
  /** Applied state of this range only: reads never see another range's keys. */
  readonly reader: KvReader;
  /** The node's whole state store, for range-local state such as transaction locks. */
  readonly state: KvReader;
  /** The range as this replica knows it now. */
  descriptor(): RangeDescriptor;
  /** Whether the replica still holds the key's range: a split may have moved it since placement. */
  owns(tenant: string, key: Uint8Array): boolean;
}

/** Where a key lives: its range, and this node's replica of it if it has one. */
export interface Placement {
  readonly rangeId: bigint;
  readonly local?: RangeTarget;
  /** Internal address of the node believed to lead the range, when it is not this one. */
  readonly address?: string;
  /** A storage key inside the range, to look it up again after a retryable failure. */
  readonly probe?: Uint8Array;
}

/** Who is asking, for commands forwarded to another node. */
export interface Caller {
  readonly tenant: string;
  readonly principal: string;
}

/** The command bodies of a transaction step (ADR-0030). */
export type TxnBody = Extract<
  NonNullable<Command['body']>,
  { case: 'txnPrewrite' | 'txnCommit' | 'txnRollback' | 'txnCheck' }
>;

/** What to run on a range, whether here or on another node (ADR-0029). */
export type RangeCall =
  | {
      readonly kind: 'command';
      readonly argv: readonly Uint8Array[];
      /** Set by the node that took the client's request; every retry of a write reuses it. */
      readonly requestId?: Uint8Array;
    }
  | {
      readonly kind: 'batch';
      readonly requestId?: Uint8Array;
      readonly writes: ReadonlyArray<readonly Uint8Array[]>;
      readonly watches: ReadonlyArray<{ readonly key: Uint8Array; readonly version: bigint }>;
    }
  /** A transaction step (prewrite, commit, rollback, check), proposed on the range; the reply is a serialised `TxnOutcome`. */
  | { readonly kind: 'txn'; readonly body: TxnBody; readonly requestId?: Uint8Array }
  /** A read as of `ts` that reports a lock instead of guessing; the reply is a serialised `TxnOutcome`. */
  | { readonly kind: 'snapshot'; readonly ts: bigint; readonly argv: readonly Uint8Array[] }
  /** MVCC versions of the keys' headers, for WATCH. */
  | { readonly kind: 'watch'; readonly keys: readonly Uint8Array[] };

/**
 * Finds the range of a key and reaches it (ADR-0029). Declared here, where
 * requests are served; `@mindlog/router` implements it with a range cache, the
 * local `Store` and node-to-node forwarding. Without a router a service
 * serves a single range.
 */
export interface RangeRouter {
  /** One placement per key, in input order. */
  place(tenant: string, keys: readonly Uint8Array[]): Promise<Result<Placement[], MindlogError>>;
  /** Runs `call` on a range this node holds no replica of, at a node that does. */
  forward(
    placement: Placement,
    caller: Caller,
    call: RangeCall,
  ): Promise<Result<KvReply, MindlogError>>;
  /** Drops what is cached for the range and places it again; absent when nothing is cached. */
  refresh?(placement: Placement): Promise<Result<Placement, MindlogError>>;
  /** Every range in key order, for commands that cover the keyspace (DBSIZE, KEYS, SCAN). */
  ranges(): Promise<Result<Placement[], MindlogError>>;
  /** This node's replica of `rangeId`, if it has an initialised one. */
  local(rangeId: bigint): RangeTarget | undefined;
  /** Any local replica, for commands without keys (PING, TIME). */
  any(): RangeTarget | undefined;
}
