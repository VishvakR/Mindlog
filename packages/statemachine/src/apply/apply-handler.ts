import type { Random } from '@mindlog/core';
import type { Command, CommandResult, RangeDescriptor } from '@mindlog/proto';
import type { KvReader, MvccTxn, WriteBatch } from '@mindlog/storage';

/** Command body kinds, e.g. `'kvWrite'`. */
export type BodyCase = NonNullable<Command['body']['case']>;

/**
 * Everything a handler may use while applying. There is no clock and no
 * ambient randomness here on purpose: time is `nowMs` (from the command's
 * HLC) and randomness is seeded from the log index (CLAUDE.md rule 1).
 */
export interface ApplyContext {
  readonly index: bigint;
  /** MVCC version of every write of this apply: max(hlc, last + 1) (ADR-0027). */
  readonly version: bigint;
  /** The applying range as of this entry; keys outside it are `RANGE_MOVED` (ADR-0029). */
  readonly descriptor: RangeDescriptor;
  readonly command: Command;
  /** Read-your-writes view of the range's latest state; all writes go through it. */
  readonly txn: MvccTxn;
  /** Physical milliseconds of the proposer's HLC. */
  readonly nowMs: bigint;
  /** Deterministic randomness, seeded from the log index. */
  readonly random: Random;
  /**
   * Raw access, written in the same atomic batch: physical deletes for GC and
   * the range-local `$node` keys of this range (`rangeLocalKey`). User data
   * goes through `txn`.
   */
  readonly raw: { readonly reader: KvReader; readonly batch: WriteBatch };
}

/**
 * Applies one kind of command body. Deterministic validation failures are
 * returned as the result; thrown errors mean an environmental failure and stop
 * the replica.
 */
export interface ApplyHandler {
  readonly body: BodyCase;
  apply(context: ApplyContext): Promise<CommandResult>;
}
