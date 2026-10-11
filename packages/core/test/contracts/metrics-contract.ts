import { describe, expect, test } from 'vitest';
import type { Labels, Metrics } from '@mindlog/core';

export interface MetricsHarness {
  readonly metrics: Metrics;
  /** Current value of a counter or gauge series. */
  read(name: string, labels?: Labels): Promise<number>;
}

/** Behaviour every Metrics implementation must have. */
export function describeMetricsContract(name: string, make: () => MetricsHarness): void {
  describe(`Metrics contract: ${name}`, () => {
    test('counters accumulate per label set', async () => {
      const h = make();
      const c = h.metrics.counter({
        name: 'mindlog_resp_commands_total',
        help: 'Commands',
        labelNames: ['command'],
      });
      c.inc(1, { command: 'GET' });
      c.inc(2, { command: 'GET' });
      c.inc(1, { command: 'SET' });
      expect(await h.read('mindlog_resp_commands_total', { command: 'GET' })).toBe(3);
      expect(await h.read('mindlog_resp_commands_total', { command: 'SET' })).toBe(1);
    });

    test('gauges set, increase and decrease', async () => {
      const h = make();
      const g = h.metrics.gauge({ name: 'mindlog_jobs_queue_depth_count', help: 'Depth' });
      g.set(10);
      g.inc(5);
      g.dec(3);
      expect(await h.read('mindlog_jobs_queue_depth_count')).toBe(12);
    });

    test('histograms accept observations', () => {
      const h = make();
      const hist = h.metrics.histogram({
        name: 'mindlog_raft_commit_latency_seconds',
        help: 'Commit latency',
        buckets: [0.001, 0.01, 0.1],
      });
      expect(() => {
        hist.observe(0.004);
      }).not.toThrow();
    });

    test('registering the same name again returns the same metric', async () => {
      const h = make();
      const options = { name: 'mindlog_kv_writes_total', help: 'Writes' };
      h.metrics.counter(options).inc();
      h.metrics.counter(options).inc();
      expect(await h.read('mindlog_kv_writes_total')).toBe(2);
    });

    test('re-registering a name as another kind throws', () => {
      const h = make();
      h.metrics.counter({ name: 'mindlog_kv_reads_total', help: 'Reads' });
      expect(() => h.metrics.gauge({ name: 'mindlog_kv_reads_total', help: 'Reads' })).toThrow(
        /already registered/,
      );
    });

    test.each([
      ['counter', 'mindlog_kv_writes'],
      ['counter', 'kv_writes_total'],
      ['gauge', 'mindlog_kv_size'],
      ['histogram', 'mindlog_Raft_latency_seconds'],
    ] as const)('rejects badly named %s %s', (kind, metricName) => {
      const h = make();
      expect(() => h.metrics[kind]({ name: metricName, help: 'x' })).toThrow();
    });
  });
}
