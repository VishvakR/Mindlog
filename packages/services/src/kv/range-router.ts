import type { MindlogError, Result } from '@mindlog/core';
import type { KvReply } from '@mindlog/proto';
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
}

/** Where a key lives: its range, and this node's replica of it if it has one. */
export interface Placement {
  readonly rangeId: bigint;
  readonly local?: RangeTarget;
}

/** Who is asking, for commands forwarded to another node. */
export interface Caller {
  readonly tenant: string;
  readonly principal: string;
}

/** What to run on a range, whether here or on another node (ADR-0029). */
export type RangeCall =
  | { readonly kind: 'command'; readonly argv: readonly Uint8Array[] }
  | {
      readonly kind: 'batch';
      readonly writes: ReadonlyArray<readonly Uint8Array[]>;
      readonly watches: ReadonlyArray<{ readonly key: Uint8Array; readonly version: bigint }>;
    }
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
  /** Every range in key order, for commands that cover the keyspace (DBSIZE, KEYS, SCAN). */
  ranges(): Promise<Result<Placement[], MindlogError>>;
  /** This node's replica of `rangeId`, if it has an initialised one. */
  local(rangeId: bigint): RangeTarget | undefined;
  /** Any local replica, for commands without keys (PING, TIME). */
  any(): RangeTarget | undefined;
}
