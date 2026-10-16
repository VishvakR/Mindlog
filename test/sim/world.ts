import { SeededRandom } from '@mindlog/core';
import type { Scheduler } from '@mindlog/multiraft';

interface Event {
  readonly time: number;
  readonly seq: number;
  readonly run: () => void;
}

/**
 * The simulated universe of one seed (PLAN 22.2): one event queue ordered by
 * (time, seq), one seeded random source, and time that jumps from event to
 * event. After each event every pending promise is drained, so a run is a
 * pure function of the seed.
 */
export class World {
  now = 0;
  readonly random: SeededRandom;
  #seq = 0;
  readonly #heap: Event[] = [];

  constructor(seed: bigint) {
    this.random = new SeededRandom(seed);
  }

  at(time: number, run: () => void): void {
    this.#push({ time: Math.max(time, this.now), seq: this.#seq++, run });
  }

  /** Uniform float in [lo, hi). */
  between(lo: number, hi: number): number {
    return lo + this.random.next() * (hi - lo);
  }

  chance(p: number): boolean {
    return this.random.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.random.next() * items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }

  /** Runs events up to `until`, calling `check` after each one. */
  async run(until: number, check: () => void): Promise<void> {
    for (;;) {
      const next = this.#heap[0];
      if (!next || next.time > until) break;
      this.#pop();
      this.now = next.time;
      next.run();
      await settle();
      check();
    }
    this.now = until;
  }

  #push(e: Event): void {
    const h = this.#heap;
    h.push(e);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(e, h[p] as Event)) break;
      h[i] = h[p] as Event;
      i = p;
    }
    h[i] = e;
  }

  #pop(): void {
    const h = this.#heap;
    const last = h.pop();
    if (!last || h.length === 0) return;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= h.length) break;
      const r = l + 1;
      const c = r < h.length && before(h[r] as Event, h[l] as Event) ? r : l;
      if (!before(h[c] as Event, last)) break;
      h[i] = h[c] as Event;
      i = c;
    }
    h[i] = last;
  }
}

const before = (a: Event, b: Event): boolean =>
  a.time < b.time || (a.time === b.time && a.seq < b.seq);

/** Every simulated store resolves without timers, so one macrotask drains all promise chains. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/**
 * Timers of one node incarnation. `rate` is how fast its clock runs relative
 * to simulated time (clock drift); a crashed incarnation's timers die with it.
 */
export class NodeScheduler implements Scheduler {
  alive = true;
  readonly #world: World;
  readonly #rate: number;

  constructor(world: World, rate: number) {
    this.#world = world;
    this.#rate = rate;
  }

  every(ms: number, fn: () => void): () => void {
    let stopped = false;
    const period = ms / this.#rate;
    const tick = (): void => {
      if (stopped || !this.alive) return;
      fn();
      this.#world.at(this.#world.now + period, tick);
    };
    this.#world.at(this.#world.now + period * this.#world.between(0, 1), tick);
    return () => {
      stopped = true;
    };
  }

  defer(fn: () => void): void {
    this.#world.at(this.#world.now, () => {
      if (this.alive) fn();
    });
  }
}
