import type { MindlogError, Result } from '@mindlog/core';

/** Read consistency levels (PLAN 9.3, ADR-0007). */
export type ReadLevel = 'linearizable' | 'lease' | 'bounded_staleness';

/**
 * Waits until this node's applied state may serve a read at `level`. Declared
 * here, where reads happen; the range replica implements it.
 */
export interface ReadBarrier {
  read(level: ReadLevel): Promise<Result<void, MindlogError>>;
}
