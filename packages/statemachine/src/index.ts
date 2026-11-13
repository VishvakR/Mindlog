/**
 * @mindlog/statemachine — deterministic command apply, idempotency, the Raft
 * log store and state snapshots (PLAN 6, ADR-0026).
 */
export type { Proposal, Proposer } from './proposer/proposer.js';
export type { ApplyContext, ApplyHandler, BodyCase } from './apply/apply-handler.js';
export { ApplyHandlerRegistry } from './apply/apply-handler-registry.js';
export { IdempotencyTable } from './system/idempotency-table.js';
export {
  appliedIndexKey,
  confStateKey,
  idempotencyAgeKey,
  idempotencyKey,
  lastVersionKey,
  logEntryKey,
  logPrefix,
  rangeDescriptorKey,
  rangeLocalKey,
  rangeLocalPrefix,
} from './system/system-keys.js';
export {
  RANGE_INIT_INDEX,
  SpanReader,
  inSpan,
  isUninitialised,
  spanIntervals,
  uninitialised,
  wholeKeyspace,
} from './range/span.js';
export { localRanges } from './range/local-ranges.js';
export { loadTombstones, writeTombstone } from './range/tombstones.js';
export { soleVoter } from './range/sole-voter.js';
export { errorResult } from './apply/command-results.js';
export type { PendingAudit } from './audit/audit.js';
export {
  auditAppendHandler,
  auditDay,
  auditDayPrefix,
  auditExpireHandler,
  auditKey,
  auditOutboxAckHandler,
  auditRangeHooks,
  readAuditOutbox,
} from './audit/audit.js';
export type { AppliedPoint, StateMachineDeps, StateSnapshot } from './apply/state-machine.js';
export { StateMachine } from './apply/state-machine.js';
export type { RangeHooks, RawState } from './range/range-commands.js';
export { mergeMembersMatch } from './range/range-commands.js';
export type { SplitPoint } from './range/split-key.js';
export { splitBoundary } from './range/split-key.js';
export type { LogUpdate, StoredLog, TruncatedPoint } from './log/raft-log-store.js';
export { RaftLogStore } from './log/raft-log-store.js';
export { STORE_FORMAT, ensureStoreFormat } from './system/store-format.js';
export { CommandStamper } from './proposer/command-stamper.js';
export type { StateGcResult } from './gc/collect-state-versions.js';
export { collectStateVersions } from './gc/collect-state-versions.js';
export { tenantPurgeHandler } from './tenant/tenant-purge.js';
