import type { WriteBatch } from '../store/kv-store.js';
import { encodeLive, TOMBSTONE_VALUE } from './version-value.js';
import { versionedKey } from './versioned-key.js';

/**
 * Writes new versions at one commit index into a batch. Every write of a
 * single apply shares the index, so the whole command becomes visible at once.
 */
export class MvccWriter {
  readonly #batch: WriteBatch;
  readonly #index: bigint;

  constructor(batch: WriteBatch, index: bigint) {
    this.#batch = batch;
    this.#index = index;
  }

  get index(): bigint {
    return this.#index;
  }

  put(logical: Uint8Array, value: Uint8Array): void {
    this.#batch.put(versionedKey(logical, this.#index), encodeLive(value));
  }

  /** Records a delete; older versions stay readable at older indexes until GC. */
  delete(logical: Uint8Array): void {
    this.#batch.put(versionedKey(logical, this.#index), TOMBSTONE_VALUE);
  }
}
