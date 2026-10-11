/**
 * @mindlog/core — shared foundations for every Mindlog package (PLAN 4.2).
 * Exports only the public API; each module is added as it lands.
 */
export type { Err, Ok, Result } from './result/result.js';
export { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result/result.js';

export type { ErrorCodeSpec, McpErrorKind } from './errors/error-codes.js';
export { ERROR_CODES, GrpcStatus, MindlogErrorCode, problemType } from './errors/error-codes.js';
export type { ErrorDetailView, MindlogError, MindlogErrorOptions } from './errors/mindlog-error.js';
export { errorSpec, isRetryable, mindlogError, toErrorDetail } from './errors/mindlog-error.js';

export type { Clock } from './clock/clock.js';
export { ManualClock } from './clock/manual-clock.js';
export { SystemClock } from './clock/system-clock.js';
