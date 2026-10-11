export type Labels = Readonly<Record<string, string>>;

export interface MetricOptions {
  /** `mindlog_<area>_<thing>_<unit>`; counters end in `_total` (CLAUDE.md §13). */
  readonly name: string;
  readonly help: string;
  readonly labelNames?: readonly string[];
}

export interface HistogramOptions extends MetricOptions {
  readonly buckets?: readonly number[];
}

export interface Counter {
  inc(amount?: number, labels?: Labels): void;
}

export interface Gauge {
  set(value: number, labels?: Labels): void;
  inc(amount?: number, labels?: Labels): void;
  dec(amount?: number, labels?: Labels): void;
}

export interface Histogram {
  observe(value: number, labels?: Labels): void;
}

/**
 * Metrics port. Registering the same name twice returns the same metric, so
 * modules can declare what they emit without coordinating; registering it as
 * a different kind is a programmer error.
 */
export interface Metrics {
  counter(options: MetricOptions): Counter;
  gauge(options: MetricOptions): Gauge;
  histogram(options: HistogramOptions): Histogram;
}

export type MetricKind = 'counter' | 'gauge' | 'histogram';

const NAME = /^mindlog_[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const UNITS = ['seconds', 'bytes', 'ratio', 'count', 'entries', 'info'];

/** Throws if `name` breaks the naming rules for `kind`. */
export function assertMetricName(name: string, kind: MetricKind): void {
  if (!NAME.test(name)) {
    throw new Error(`metric "${name}" must match mindlog_<area>_<thing>_<unit> in snake_case`);
  }
  const suffix = name.slice(name.lastIndexOf('_') + 1);
  if (kind === 'counter' && suffix !== 'total') {
    throw new Error(`counter "${name}" must end in _total`);
  }
  if (kind !== 'counter' && !UNITS.includes(suffix)) {
    throw new Error(`${kind} "${name}" must end in a unit: ${UNITS.join(', ')}`);
  }
}
