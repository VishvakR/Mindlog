import type { MetricKind } from './metrics.js';
import { assertMetricName } from './metrics.js';

/** Name validation and idempotent registration shared by Metrics implementations. */
export class MetricCache {
  readonly #byName = new Map<string, { kind: MetricKind; metric: unknown }>();

  getOrCreate<T>(name: string, kind: MetricKind, create: () => T): T {
    const existing = this.#byName.get(name);
    if (existing) {
      if (existing.kind !== kind) {
        throw new Error(`metric "${name}" is already registered as a ${existing.kind}`);
      }
      return existing.metric as T;
    }
    assertMetricName(name, kind);
    const metric = create();
    this.#byName.set(name, { kind, metric });
    return metric;
  }
}
