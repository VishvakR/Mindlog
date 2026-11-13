/**
 * @mindlog/pd — the placement driver (PLAN 8.3, ADR-0010).
 */
export { PD_DESCRIPTOR, PD_HANDLERS, decodeU64, encodeU64, integerResult } from './pd-handlers.js';
export { FIRST_ALLOCATED_ID, INFINITY, PD_RANGE_ID } from './pd-keys.js';
export { PdView, contains } from './pd-view.js';
export { clearPlacement } from './pd-restore.js';
export type {
  ClusterView,
  NodeView,
  PdConfig,
  Plan,
  PlannedOperator,
  PlannedStep,
  RangeView,
  Scheduler,
} from './cluster-view.js';
export { DEFAULT_PD_CONFIG } from './cluster-view.js';
export { eligibleNodes, leaderCounts, pickTarget, replicaCounts } from './placement.js';
export {
  DEFAULT_SCHEDULERS,
  drainScheduler,
  leaderBalanceScheduler,
  mergeScheduler,
  repairScheduler,
  replicaBalanceScheduler,
  splitScheduler,
} from './schedulers.js';
export type { IdSource } from './operators.js';
export { OperatorController } from './operators.js';
export type { PdGroup, PdServiceDeps } from './pd-service.js';
export { PdService } from './pd-service.js';
export type { PdServer, PdServerOptions } from './pd-rpc.js';
export { ConnectPdClient, InProcessPdClient, pdRoutes, startPdServer } from './pd-rpc.js';
