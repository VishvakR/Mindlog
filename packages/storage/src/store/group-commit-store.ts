import type { KeyRange } from '@mindlog/core';
import type { Entry, IterateOptions, KvStore, StoreSnapshot, WriteBatch } from './kv-store.js';

type Op = readonly [key: Uint8Array, value: Uint8Array | null];

interface Group {
  readonly ops: Op[];
  sync: boolean;
  readonly done: Promise<void>;
}

/**
 * Group commit across writers (PLAN 8.2): every batch written in the same
 * event-loop turn reaches the store as one batch, synced if any of them asked
 * for it. Each batch stays atomic because the combined batch is. The Raft log
 * store of a node uses it so that all ranges' log appends of a Ready cycle
 * cost one fsync. Writers must touch disjoint keys within a turn (ranges do).
 */
export class GroupCommitStore implements KvStore {
  readonly #inner: KvStore;
  #group: Group | undefined;

  constructor(inner: KvStore) {
    this.#inner = inner;
  }

  get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.#inner.get(key);
  }

  iterate(range: KeyRange, options?: IterateOptions): AsyncIterable<Entry> {
    return this.#inner.iterate(range, options);
  }

  snapshot(): Promise<StoreSnapshot> {
    return this.#inner.snapshot();
  }

  close(): Promise<void> {
    return this.#inner.close();
  }

  batch(): WriteBatch {
    const ops: Op[] = [];
    return {
      put: (key, value) => {
        ops.push([key, value]);
      },
      del: (key) => {
        ops.push([key, null]);
      },
      get length() {
        return ops.length;
      },
      write: (options) => this.#join(ops, options?.sync ?? false),
    };
  }

  #join(ops: readonly Op[], sync: boolean): Promise<void> {
    const group = (this.#group ??= this.#open());
    group.ops.push(...ops);
    group.sync ||= sync;
    return group.done;
  }

  #open(): Group {
    const ops: Op[] = [];
    let release!: () => void;
    const turnEnded = new Promise<void>((resolve) => {
      release = resolve;
    });
    setImmediate(release);
    const group: Group = {
      ops,
      sync: false,
      done: turnEnded.then(async () => {
        this.#group = undefined;
        const batch = this.#inner.batch();
        for (const [key, value] of ops) {
          if (value === null) batch.del(key);
          else batch.put(key, value);
        }
        await batch.write({ sync: group.sync });
      }),
    };
    return group;
  }
}
