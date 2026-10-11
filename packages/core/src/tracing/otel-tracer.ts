import type { Attributes, Span, Tracer as OtelApiTracer, TracerProvider } from '@opentelemetry/api';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { SpanAttributeValue, SpanAttributes, SpanHandle, Tracer } from './tracer.js';

const TRACER_NAME = '@mindlog/core';

/**
 * Tracer on the OpenTelemetry API. With no SDK registered every call is a
 * cheap no-op, so instrumented code needs no feature checks.
 */
export class OtelTracer implements Tracer {
  readonly #tracer: OtelApiTracer;

  constructor(provider: TracerProvider = trace.getTracerProvider()) {
    this.#tracer = provider.getTracer(TRACER_NAME);
  }

  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return this.#tracer.startActiveSpan(name, { attributes: toOtel(attributes) }, async (span) => {
      try {
        const result = await fn({
          setAttribute: (key, value) => {
            span.setAttribute(key, toOtelValue(value));
          },
        });
        markResult(span, result);
        return result;
      } catch (error: unknown) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/** `Err` results are failures too: record the error code without throwing. */
function markResult(span: Span, result: unknown): void {
  if (typeof result !== 'object' || result === null || !('ok' in result)) return;
  if (result.ok !== false || !('error' in result)) return;
  const error = result.error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'ERROR';
  span.setAttribute('mindlog.error.code', code);
  span.setStatus({ code: SpanStatusCode.ERROR, message: code });
}

function toOtelValue(value: SpanAttributeValue): string | number | boolean {
  return typeof value === 'bigint' ? value.toString() : value;
}

function toOtel(attributes: SpanAttributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) out[key] = toOtelValue(value);
  return out;
}
