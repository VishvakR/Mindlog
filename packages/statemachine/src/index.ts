/**
 * @mindlog/statemachine — deterministic command apply, idempotency and the
 * single-node log behind the Proposer port (PLAN 6).
 */
export type { Proposal, Proposer } from './proposer/proposer.js';
export type { ApplyContext, ApplyHandler, BodyCase } from './apply/apply-handler.js';
export { ApplyHandlerRegistry } from './apply/apply-handler-registry.js';
