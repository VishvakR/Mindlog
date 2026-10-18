import type { CommandResult } from '@mindlog/proto';
import type { ApplyContext } from '@mindlog/statemachine';

/**
 * Lets another package veto a write before it runs, e.g. because a transaction
 * holds a lock on one of its keys (ADR-0030). Returns the result to record, or
 * nothing to let the write run.
 */
export type WriteGuard = (
  context: ApplyContext,
  keys: readonly Uint8Array[],
) => Promise<CommandResult | undefined>;
