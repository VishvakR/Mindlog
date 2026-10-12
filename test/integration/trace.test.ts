import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Redis } from 'ioredis';
import { afterAll, expect, test } from 'vitest';
import { startTestNode } from '../support/node.js';

// Registered globally for this file only (vitest isolates files), as initTracing does in production.
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

afterAll(async () => {
  await provider.shutdown();
});

test('one trace shows RESP → KV → apply → storage for a write (phase 2 gate)', async () => {
  const node = await startTestNode();
  const { port } = node;
  const client = new Redis({ port, host: '127.0.0.1', lazyConnect: true });
  try {
    await client.connect();
    exporter.reset();
    expect(await client.set('traced', 'yes')).toBe('OK');
  } finally {
    client.disconnect();
    await node.stop();
  }
  const spans = exporter.getFinishedSpans();
  const root = spans.find(
    (s) => s.name === 'resp.command' && s.attributes['mindlog.command'] === 'SET',
  );
  expect(root).toBeDefined();
  const traceId = root?.spanContext().traceId;
  const trace = spans.filter((s) => s.spanContext().traceId === traceId);
  const byId = new Map(trace.map((s) => [s.spanContext().spanId, s]));
  const parentName = (name: string) => {
    const span = trace.find((s) => s.name === name);
    const parentId = span?.parentSpanContext?.spanId;
    return parentId ? byId.get(parentId)?.name : undefined;
  };
  expect(parentName('kv.set')).toBe('resp.command');
  expect(parentName('storage.write')).toBe('kv.set');
  expect(parentName('statemachine.apply')).toBe('kv.set');
});
