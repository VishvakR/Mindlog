/**
 * @mindlog/services — application services: sessions, authentication and the
 * KV request path (layer `application`).
 */
export { StaticAuthenticator } from './auth/static-authenticator.js';
export type { PendingTransaction, WatchedKey } from './session/session.js';
export { Session } from './session/session.js';
export type { KvServiceDeps } from './kv/kv-service.js';
export { KvService, commandName } from './kv/kv-service.js';
