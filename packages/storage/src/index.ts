/**
 * @mindlog/storage — ordered key-value storage behind the KvStore port, with
 * MVCC on top (PLAN 10).
 */
export type {
  Entry,
  IterateOptions,
  KvReader,
  KvStore,
  StoreSnapshot,
  WriteBatch,
} from './store/kv-store.js';
export { compareBytes } from './store/compare-bytes.js';
export { MemoryStore } from './store/memory-store.js';
