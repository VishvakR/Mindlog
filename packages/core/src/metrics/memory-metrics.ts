import type {
  Counter,
  Gauge,
  Histogram,
  HistogramOptions,
  Labels,
  MetricOptions,
  Metrics,
} from './metrics.js';
import { MetricCache } from './registry-base.js';

function seriesKey(name: string, labels: Labels): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`);
  return `${name}{${parts.join(',')}}`;
}

/** In-memory Metrics for tests and the simulator; values are inspectable. */
export class MemoryMetrics implements Metrics {
  readonly #cache = new MetricCache();
  readonly #values = new Map<string, number>();
  readonly #observations = new Map<string, number[]>();

  counter(options: MetricOptions): Counter {
    return this.#cache.getOrCreate(options.name, 'counter', () => ({
      inc: (amount = 1, labels: Labels = {}) => {
        if (amount < 0) throw new Error('counters only go up');
        this.#add(seriesKey(options.name, labels), amount);
      },
    }));
  }

  gauge(options: MetricOptions): Gauge {
    return this.#cache.getOrCreate(options.name, 'gauge', () => ({
      set: (value, labels: Labels = {}) => this.#values.set(seriesKey(options.name, labels), value),
      inc: (amount = 1, labels: Labels = {}) => {
        this.#add(seriesKey(options.name, labels), amount);
      },
      dec: (amount = 1, labels: Labels = {}) => {
        this.#add(seriesKey(options.name, labels), -amount);
      },
    }));
  }

  histogram(options: HistogramOptions): Histogram {
    return this.#cache.getOrCreate(options.name, 'histogram', () => ({
      observe: (value, labels: Labels = {}) => {
        const key = seriesKey(options.name, labels);
        const list = this.#observations.get(key) ?? [];
        list.push(value);
        this.#observations.set(key, list);
      },
    }));
  }

  /** Current counter or gauge value (0 if never touched). */
  value(name: string, labels: Labels = {}): number {
    return this.#values.get(seriesKey(name, labels)) ?? 0;
  }

  /** Every value observed by a histogram series. */
  observations(name: string, labels: Labels = {}): readonly number[] {
    return this.#observations.get(seriesKey(name, labels)) ?? [];
  }

  #add(key: string, amount: number): void {
    this.#values.set(key, (this.#values.get(key) ?? 0) + amount);
  }
}
