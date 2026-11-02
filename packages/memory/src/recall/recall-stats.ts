import type { MemoryRange, MemoryScope } from '../types.js';

/** Recalled ids of one scope waiting to be proposed. */
export interface PendingStats {
  readonly range: MemoryRange;
  readonly scope: MemoryScope;
  readonly ids: Set<string>;
  /** Of those, the cold ones to bring back hot. */
  readonly cold: Set<string>;
}

export interface RecallStatsOptions {
  /** Proposes one scope's batch (`MemoryRecallStats`, then the cold promotions). */
  readonly flush: (pending: PendingStats) => Promise<void>;
  /** Ids a scope may have waiting; more are dropped (and counted). */
  readonly maxIds: number;
  readonly onDropped?: (n: number) => void;
}

/**
 * PLAN 12.4 stage 10 RecordRecall: recalled ids batched per scope and
 * proposed every interval (2 s), off the recall's path.
 */
export class RecallStats {
  readonly #o: RecallStatsOptions;
  #pending = new Map<string, PendingStats>();
  #timer: NodeJS.Timeout | undefined;
  #flushing: Promise<void> | undefined;

  constructor(options: RecallStatsOptions) {
    this.#o = options;
  }

  add(
    range: MemoryRange,
    scope: MemoryScope,
    ids: readonly string[],
    cold: readonly string[],
  ): void {
    const key = `${String(range.rangeId)}\u0000${scope.tenant}\u0000${scope.user}`;
    let p = this.#pending.get(key);
    if (!p) {
      p = {
        range,
        scope: { tenant: scope.tenant, user: scope.user },
        ids: new Set(),
        cold: new Set(),
      };
      this.#pending.set(key, p);
    }
    let dropped = 0;
    for (const id of ids) {
      if (p.ids.size >= this.#o.maxIds && !p.ids.has(id)) dropped++;
      else p.ids.add(id);
    }
    for (const id of cold) if (p.ids.has(id)) p.cold.add(id);
    if (dropped > 0) this.#o.onDropped?.(dropped);
  }

  /** Proposes everything waiting; a flush already running is awaited first. */
  async flush(): Promise<void> {
    await this.#flushing;
    const batch = [...this.#pending.values()];
    this.#pending = new Map();
    this.#flushing = Promise.all(batch.map((p) => this.#o.flush(p))).then(() => undefined);
    await this.#flushing;
    this.#flushing = undefined;
  }

  start(intervalMs: number): void {
    this.#timer ??= setInterval(() => void this.flush(), intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.flush();
  }
}
