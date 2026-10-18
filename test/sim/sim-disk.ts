import type { KeyRange } from '@mindlog/core';
import type { Entry, IterateOptions, KvStore, StoreSnapshot, WriteBatch } from '@mindlog/storage';
import { MemoryStore } from '@mindlog/storage';

type Op = readonly ['put', Uint8Array, Uint8Array] | readonly ['del', Uint8Array];

const WHOLE: KeyRange = { start: new Uint8Array(), end: Uint8Array.of(0xff) };

/**
 * A disk with LevelDB's durability: writes land in the OS cache at once and
 * reach the platter with the next synced write (which syncs everything
 * before it, like LevelDB's WAL). A process crash keeps the cache; a power
 * loss keeps only a prefix of the unsynced batches.
 */
export class SimDisk {
  #durable = new MemoryStore();
  #live = new MemoryStore();
  #unsynced: Op[][] = [];
  /** Durable writes in the order they were synced. */
  #durableWrites: Promise<void> = Promise.resolve();
  #incarnation = 0;

  /** A handle for the current incarnation; it stops working after a crash. */
  open(): KvStore {
    const incarnation = this.#incarnation;
    const check = (): void => {
      if (incarnation !== this.#incarnation) throw new Error('the process crashed');
    };
    const reader = {
      get: (key: Uint8Array) => {
        check();
        return this.#live.get(key);
      },
      iterate: (range: KeyRange, options?: IterateOptions): AsyncIterable<Entry> => {
        check();
        return this.#live.iterate(range, options);
      },
    };
    return {
      ...reader,
      snapshot: (): Promise<StoreSnapshot> => {
        check();
        return this.#live.snapshot();
      },
      close: () => Promise.resolve(),
      batch: (): WriteBatch => {
        const ops: Op[] = [];
        return {
          put: (k, v) => ops.push(['put', k.slice(), v.slice()]),
          del: (k) => ops.push(['del', k.slice()]),
          get length() {
            return ops.length;
          },
          write: async (options) => {
            check();
            await apply(this.#live, ops);
            if (!options?.sync) {
              this.#unsynced.push(ops);
              return;
            }
            // A sync makes everything before it durable, in order. The pending list is taken before
            // any await: a batch written meanwhile belongs after this one, not lost with it.
            const pending = [...this.#unsynced, ops];
            this.#unsynced = [];
            this.#durableWrites = this.#durableWrites.then(async () => {
              for (const batch of pending) await apply(this.#durable, batch);
            });
            await this.#durableWrites;
          },
        };
      },
    };
  }

  /** Kills every handle; with `powerLoss`, keeps only the first `keep` unsynced batches. */
  async crash(powerLoss: boolean, keep: number): Promise<void> {
    this.#incarnation++;
    if (!powerLoss) return;
    for (const ops of this.#unsynced.slice(0, keep)) await apply(this.#durable, ops);
    this.#unsynced = [];
    this.#live = new MemoryStore();
    const copy: Op[] = [];
    for await (const [k, v] of this.#durable.iterate(WHOLE)) copy.push(['put', k, v]);
    await apply(this.#live, copy);
  }

  get unsyncedBatches(): number {
    return this.#unsynced.length;
  }
}

async function apply(store: MemoryStore, ops: readonly Op[]): Promise<void> {
  if (ops.length === 0) return;
  const batch = store.batch();
  for (const op of ops) {
    if (op[0] === 'put') batch.put(op[1], op[2]);
    else batch.del(op[1]);
  }
  await batch.write();
}
