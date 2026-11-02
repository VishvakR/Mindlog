import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';

/**
 * Bytes by key (PLAN 10.4 cold tier, 16.5 files). A `put` is durable when it
 * resolves, so a command naming the blob can be proposed after it.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<Result<void, MindlogError>>;
  /** Undefined when there is no such blob. */
  get(key: string): Promise<Result<Uint8Array | undefined, MindlogError>>;
  /** Deleting a missing blob succeeds. */
  delete(key: string): Promise<Result<void, MindlogError>>;
}

const KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

/** Keys are `/`-separated segments of `[A-Za-z0-9._-]`, without `.` or `..` segments. */
export function checkKey(key: string): Result<string, MindlogError> {
  if (key.length > 512 || !KEY.test(key) || key.split('/').some((s) => s === '.' || s === '..'))
    return err(mindlogError('INVALID_ARGUMENT', `invalid blob key ${JSON.stringify(key)}`));
  return ok(key);
}

/** In-memory blobs, for tests and the simulator. */
export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): Promise<Result<void, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return Promise.resolve(k);
    this.#blobs.set(key, bytes.slice());
    return Promise.resolve(ok(undefined));
  }

  get(key: string): Promise<Result<Uint8Array | undefined, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return Promise.resolve(k);
    return Promise.resolve(ok(this.#blobs.get(key)?.slice()));
  }

  delete(key: string): Promise<Result<void, MindlogError>> {
    const k = checkKey(key);
    if (!k.ok) return Promise.resolve(k);
    this.#blobs.delete(key);
    return Promise.resolve(ok(undefined));
  }

  /** Every stored key, sorted. */
  keys(): string[] {
    return [...this.#blobs.keys()].sort();
  }
}
