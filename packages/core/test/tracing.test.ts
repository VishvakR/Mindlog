import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, test } from 'vitest';
import { OtelTracer, err, initTracing, mindlogError, ok } from '@mindlog/core';

function setup() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  return { exporter, tracer: new OtelTracer(provider) };
}

describe('OtelTracer', () => {
  test('records a span with attributes, converting bigints to strings', async () => {
    const { exporter, tracer } = setup();
    const value = await tracer.withSpan('kv.get', { tenant: 'acme', rangeId: 7n }, (span) => {
      span.setAttribute('hlc', 2n ** 63n);
      return Promise.resolve(42);
    });
    expect(value).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('kv.get');
    expect(span?.attributes).toMatchObject({
      tenant: 'acme',
      rangeId: '7',
      hlc: (2n ** 63n).toString(),
    });
    expect(span?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test('marks Err results as failed with the error code', async () => {
    const { exporter, tracer } = setup();
    await tracer.withSpan('kv.get', {}, () =>
      Promise.resolve(err(mindlogError('NOT_FOUND', 'missing'))),
    );
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'NOT_FOUND' });
    expect(span?.attributes['mindlog.error.code']).toBe('NOT_FOUND');
  });

  test('leaves Ok results unmarked', async () => {
    const { exporter, tracer } = setup();
    await tracer.withSpan('kv.set', {}, () => Promise.resolve(ok('done')));
    expect(exporter.getFinishedSpans()[0]?.status.code).toBe(SpanStatusCode.UNSET);
  });

  test('records thrown errors, ends the span and rethrows', async () => {
    const { exporter, tracer } = setup();
    await expect(
      tracer.withSpan('boom', {}, () => Promise.reject(new Error('disk on fire'))),
    ).rejects.toThrow('disk on fire');
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  test('is a no-op without an SDK', async () => {
    await expect(new OtelTracer().withSpan('noop', {}, () => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe('initTracing', () => {
  test('stays off without an endpoint', async () => {
    const handle = initTracing({ serviceName: 'mindlog', sampleRatio: 1 });
    expect(handle.enabled).toBe(false);
    await handle.shutdown();
  });
});
