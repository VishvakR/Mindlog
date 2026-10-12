import type { Random } from '@mindlog/core';
import type { Command, CommandResult } from '@mindlog/proto';
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
  readonly command: Command;
  /** Read-your-writes view of latest state; all writes go through it. */
  readonly txn: MvccTxn;
  /** Physical milliseconds of the proposer's HLC. */
  readonly nowMs: bigint;
  /** Deterministic randomness, seeded from the log index. */
  readonly random: Random;
  /**
   * Raw access for maintenance handlers only (GC): physical deletes and
   * `$node` keys, written in the same atomic batch. Everything else uses `txn`.
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
