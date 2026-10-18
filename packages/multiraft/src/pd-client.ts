import type { MindlogError, Result } from '@mindlog/core';
import type {
  RangeDescriptor,
  RangeHeartbeatResponse,
  RangeStats,
  StoreHeartbeatResponse,
  StoreStats,
} from '@mindlog/proto';

/**
 * What a node needs from the placement driver (PLAN 8.3). Declared here, where
 * it is used; `@mindlog/pd` implements it in process and over Connect. Calls
 * fail with `NOT_LEADER` or `UNAVAILABLE` while PD has no leader, and callers
 * carry on with what they know (PLAN 21: the data path never waits for PD).
 */
export interface PdClient {
  /** Allocates `count` consecutive ids; resolves with the first. */
  allocIds(count: number): Promise<Result<bigint, MindlogError>>;
  /** A batch of `count` timestamps; resolves with the last. */
  tso(count: number): Promise<Result<bigint, MindlogError>>;
  getRange(
    key: Uint8Array,
  ): Promise<Result<{ range: RangeDescriptor; leaderReplicaId: bigint }, MindlogError>>;
  scanRanges(start: Uint8Array, limit: number): Promise<Result<RangeDescriptor[], MindlogError>>;
  storeHeartbeat(stats: StoreStats): Promise<Result<StoreHeartbeatResponse, MindlogError>>;
  rangeHeartbeat(stats: RangeStats): Promise<Result<RangeHeartbeatResponse, MindlogError>>;
}
