import type { KeyRange } from '@mindlog/core';

export type Entry = readonly [key: Uint8Array, value: Uint8Array];

export interface IterateOptions {
  /** Newest-to-oldest byte order instead of ascending. */
  readonly reverse?: boolean;
  /** Maximum number of entries to yield. */
  readonly limit?: number;
}

/** Read access shared by a store and its snapshots. */
export interface KvReader {
  get(key: Uint8Array): Promise<Uint8Array | undefined>;
  /** Entries in `[range.start, range.end)` in byte order (or reversed). */
  iterate(range: KeyRange, options?: IterateOptions): AsyncIterable<Entry>;
}

/** A set of puts and deletes applied atomically by `write`. */
export interface WriteBatch {
  put(key: Uint8Array, value: Uint8Array): void;
  del(key: Uint8Array): void;
  /** Number of operations queued. */
  readonly length: number;
  /** Applies every operation atomically; `sync` waits for fsync. */
  write(options?: { readonly sync?: boolean }): Promise<void>;
}

/** A consistent read-only view; must be released. */
export interface StoreSnapshot extends KvReader {
  release(): Promise<void>;
}

/**
 * Ordered byte-key storage port (PLAN 4.3, 10.1). Keys compare as unsigned
 * bytes. I/O failures throw: they are environmental, and callers fail-stop
 * (CLAUDE.md rule 6) rather than handle them.
 */
export interface KvStore extends KvReader {
  batch(): WriteBatch;
  snapshot(): Promise<StoreSnapshot>;
  close(): Promise<void>;
}
