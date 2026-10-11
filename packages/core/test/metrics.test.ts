import { describe, expect, test } from 'vitest';
import { MemoryMetrics, PromMetrics, assertMetricName } from '@mindlog/core';
import { describeMetricsContract } from './contracts/metrics-contract.js';

describeMetricsContract('PromMetrics', () => {
  const metrics = new PromMetrics();
  return {
    metrics,
    read: async (name, labels = {}) => {
      const metric = metrics.registry.getSingleMetric(name);
      if (!metric) return 0;
      const data = await metric.get();
      const match = data.values.find((v) =>
        Object.entries(labels).every(([k, val]) => v.labels[k] === val),
      );
      return match?.value ?? 0;
    },
  };
});

describeMetricsContract('MemoryMetrics', () => {
  const metrics = new MemoryMetrics();
  return { metrics, read: (name, labels) => Promise.resolve(metrics.value(name, labels)) };
});

describe('PromMetrics', () => {
  test('renders the Prometheus text format', async () => {
    const metrics = new PromMetrics();
    metrics.counter({ name: 'mindlog_http_requests_total', help: 'HTTP requests' }).inc(4);
    const text = await metrics.render();
    expect(text).toContain('# TYPE mindlog_http_requests_total counter');
    expect(text).toContain('mindlog_http_requests_total 4');
    expect(metrics.contentType).toContain('text/plain');
  });

  test('instances do not share a registry', () => {
    const options = { name: 'mindlog_kv_deletes_total', help: 'Deletes' };
    new PromMetrics().counter(options);
    expect(() => new PromMetrics().counter(options)).not.toThrow();
  });
});

describe('MemoryMetrics', () => {
  test('records histogram observations and rejects negative counter increments', () => {
    const metrics = new MemoryMetrics();
    const h = metrics.histogram({ name: 'mindlog_memory_recall_latency_seconds', help: 'Recall' });
    h.observe(0.02, { stage: 'vector' });
    expect(
      metrics.observations('mindlog_memory_recall_latency_seconds', { stage: 'vector' }),
    ).toEqual([0.02]);
    const c = metrics.counter({ name: 'mindlog_memory_writes_total', help: 'Writes' });
    expect(() => {
      c.inc(-1);
    }).toThrow();
  });
});

describe('assertMetricName', () => {
  test('accepts the documented examples', () => {
    expect(() => {
      assertMetricName('mindlog_raft_commit_latency_seconds', 'histogram');
      assertMetricName('mindlog_storage_size_bytes', 'gauge');
      assertMetricName('mindlog_cache_hit_ratio', 'gauge');
    }).not.toThrow();
  });
});
