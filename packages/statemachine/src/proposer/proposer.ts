import type { MindlogError, Result } from '@mindlog/core';
import type { Command, CommandResult } from '@mindlog/proto';

/** A committed and applied command: its log index and its stored result. */
export interface Proposal {
  readonly index: bigint;
  readonly result: CommandResult;
}

/**
 * The only write path into replicated state (PLAN 4.3). Resolves after the
 * command is durable in the log and applied, so a successful result is safe
 * to acknowledge. Expected failures: `BUSY` (proposal queue full),
 * `UNAVAILABLE` (proposer stopped or failed); later `NOT_LEADER`.
 *
 * Phase 1 implements it with a single-node local log; phase 3 swaps in Raft
 * behind the same port.
 */
export interface Proposer {
  propose(command: Command): Promise<Result<Proposal, MindlogError>>;
}
