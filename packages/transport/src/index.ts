/**
 * @mindlog/transport — node-to-node Raft messaging over Connect's gRPC
 * protocol on HTTP/2 (ADR-0025). Implements the RaftTransport port of
 * @mindlog/multiraft.
 */
export type { ConnectTransportOptions } from './connect-transport.js';
export { ConnectTransport } from './connect-transport.js';
export type { ForwardHandler } from './forward.js';
export { KvForwarder, forwardRoutes } from './forward.js';
