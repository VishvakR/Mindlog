/** @mindlog/sdk — collections, auth, files and realtime over HTTP. No dependencies. */
export type { AuthRecord, AuthStorage } from './auth-store.js';
export { AuthStore } from './auth-store.js';
export type {
  ClientOptions,
  RecordModel,
  RecordQuery,
  RealtimeEvent,
  ListResult,
} from './client.js';
export { ClientError, MindlogClient, RecordService } from './client.js';
