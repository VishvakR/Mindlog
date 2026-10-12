/**
 * @mindlog/statemachine — deterministic command apply, idempotency and the
 * single-node log behind the Proposer port (PLAN 6).
 */
export type { Proposal, Proposer } from './proposer/proposer.js';
export type { ApplyContext, ApplyHandler, BodyCase } from './apply/apply-handler.js';
export { ApplyHandlerRegistry } from './apply/apply-handler-registry.js';
export { IdempotencyTable } from './system/idempotency-table.js';
export { appliedIndexKey, idempotencyKey, logEntryKey, logPrefix } from './system/system-keys.js';
export { errorResult } from './apply/command-results.js';
export type { StateMachineDeps } from './apply/state-machine.js';
export { StateMachine } from './apply/state-machine.js';
export { LocalLog } from './log/local-log.js';
