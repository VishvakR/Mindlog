/**
 * @mindlog/core — shared foundations for every Mindlog package (PLAN 4.2).
 * Exports only the public API; each module is added as it lands.
 */
export type { Err, Ok, Result } from './result/result.js';
export { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result/result.js';
