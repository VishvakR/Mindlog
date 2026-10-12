import type { KeyRange, MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import { ClassicLevel } from 'classic-level';
import type {
  Entry,
  IterateOptions,
  KvReader,
  KvStore,
  StoreSnapshot,
  WriteBatch,
} from './kv-store.js';

type Db = ClassicLevel<Uint8Array, Uint8Array>;
type DbSnapshot = ReturnType<Db['snapshot']>;

export interface LevelDbOptions {
  /** LevelDB block cache in bytes (default 8 MiB). */
  readonly cacheSize?: number;
  /** In-memory write buffer before a level-0 flush (default 4 MiB). */
  readonly writeBufferSize?: number;
}

/** Copies into a plain Uint8Array so callers never hold views into LevelDB buffers. */
function own(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function readerOf(db: Db, snapshot?: DbSnapshot): KvReader {
  const at = snapshot ? { snapshot } : {};
  return {
    get: async (key) => {
      const value = await db.get(key, at);
      return value === undefined ? undefined : own(value);
    },
    iterate: (range: KeyRange, options: IterateOptions = {}) => {
      const iterator = db.iterator({
        gte: range.start,
        lt: range.end,
        reverse: options.reverse ?? false,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
        ...at,
      });
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Entry> {
          try {
            for await (const [key, value] of iterator) yield [own(key), own(value)] as const;
          } finally {
            await iterator.close();
          }
        },
      };
    },
  };
}

/**
 * Production KvStore on LevelDB via classic-level (ADR-0005). Each instance
 * owns its directory exclusively; a second open of the same path fails.
 */
export class LevelDbStore implements KvStore {
  readonly #db: Db;
  readonly #reader: KvReader;

  private constructor(db: Db) {
    this.#db = db;
    this.#reader = readerOf(db);
  }

  static async open(
    location: string,
    options: LevelDbOptions = {},
  ): Promise<Result<LevelDbStore, MindlogError>> {
    const db: Db = new ClassicLevel<Uint8Array, Uint8Array>(location, {
      keyEncoding: 'view',
      valueEncoding: 'view',
      createIfMissing: true,
      ...options,
    });
    try {
      await db.open();
      return ok(new LevelDbStore(db));
    } catch (cause: unknown) {
      const locked = (cause as { cause?: { code?: string } }).cause?.code === 'LEVEL_LOCKED';
      const message = locked
        ? `store at ${location} is in use by another process`
        : `cannot open store at ${location}`;
      return err(mindlogError('UNAVAILABLE', message, { cause }));
    }
  }

  get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.#reader.get(key);
  }

  iterate(range: KeyRange, options?: IterateOptions): AsyncIterable<Entry> {
    return this.#reader.iterate(range, options);
  }

  batch(): WriteBatch {
    const chained = this.#db.batch();
    return {
      put: (key, value) => {
        chained.put(key, value);
      },
      del: (key) => {
        chained.del(key);
      },
      get length() {
        return chained.length;
      },
      write: (options = {}) => chained.write({ sync: options.sync ?? false }),
    };
  }

  snapshot(): Promise<StoreSnapshot> {
    const snapshot = this.#db.snapshot();
    const reader = readerOf(this.#db, snapshot);
    return Promise.resolve({ ...reader, release: () => snapshot.close() });
  }

  close(): Promise<void> {
    return this.#db.close();
  }
}
