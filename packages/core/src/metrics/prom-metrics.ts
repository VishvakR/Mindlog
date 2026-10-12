import client from '@prometheus-io/client';
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

/** Production Metrics backed by an isolated @prometheus-io/client registry (PLAN 19.1). */
export class PromMetrics implements Metrics {
  readonly registry = new client.Registry();
  readonly #cache = new MetricCache();

  /**
   * Adds Node.js process series (CPU, RSS, heap, GC, event-loop lag) as
   * `mindlog_process_*` and `mindlog_nodejs_*`. Call once per process.
   */
  collectProcessMetrics(): void {
    client.collectDefaultMetrics({ register: this.registry, prefix: 'mindlog_' });
  }

  counter(options: MetricOptions): Counter {
    return this.#cache.getOrCreate(options.name, 'counter', () => {
      const c = new client.Counter({ ...base(options), registers: [this.registry] });
      return {
        inc: (amount = 1, labels: Labels = {}) => {
          c.inc(labels, amount);
        },
      };
    });
  }

  gauge(options: MetricOptions): Gauge {
    return this.#cache.getOrCreate(options.name, 'gauge', () => {
      const g = new client.Gauge({ ...base(options), registers: [this.registry] });
      return {
        set: (value, labels: Labels = {}) => {
          g.set(labels, value);
        },
        inc: (amount = 1, labels: Labels = {}) => {
          g.inc(labels, amount);
        },
        dec: (amount = 1, labels: Labels = {}) => {
          g.dec(labels, amount);
        },
      };
    });
  }

  histogram(options: HistogramOptions): Histogram {
    return this.#cache.getOrCreate(options.name, 'histogram', () => {
      const h = new client.Histogram({
        ...base(options),
        ...(options.buckets ? { buckets: [...options.buckets] } : {}),
        registers: [this.registry],
      });
      return {
        observe: (value, labels: Labels = {}) => {
          h.observe(labels, value);
        },
      };
    });
  }

  /** Prometheus text exposition for `/metrics`. */
  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}

function base(options: MetricOptions) {
  return { name: options.name, help: options.help, labelNames: [...(options.labelNames ?? [])] };
}
