/**
 * @mindlog/router — finds the range of a key and reaches its leader, locally or
 * by forwarding to the node that holds it (ADR-0029). Implements the
 * `RangeRouter` port declared by @mindlog/services.
 */
export type { ForwardCall } from './forward-call.js';
export { connectForwardCall, fromRequest, toRequest } from './forward-codec.js';
export type { LocalRanges, StoreRouterDeps } from './store-router.js';
export { StoreRouter } from './store-router.js';
