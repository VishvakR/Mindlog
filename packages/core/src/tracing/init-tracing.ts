import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';

export interface TracingOptions {
  readonly serviceName: string;
  /** OTLP/HTTP collector base URL, e.g. `http://jaeger:4318`. Unset: tracing off. */
  readonly endpoint?: string | undefined;
  /** Fraction of new root traces to sample (PLAN 19.2). */
  readonly sampleRatio: number;
}

export interface TracingHandle {
  readonly enabled: boolean;
  /** Flushes pending spans and stops exporting. */
  shutdown(): Promise<void>;
}

/**
 * Installs the global OpenTelemetry SDK. Off unless an endpoint is configured,
 * because Mindlog makes no network calls by default (ADR-020).
 */
export function initTracing(options: TracingOptions): TracingHandle {
  if (options.endpoint === undefined) {
    return { enabled: false, shutdown: () => Promise.resolve() };
  }
  const url = options.endpoint.endsWith('/v1/traces')
    ? options.endpoint
    : `${options.endpoint.replace(/\/$/, '')}/v1/traces`;
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(options.sampleRatio) }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url }))],
  });
  provider.register();
  return { enabled: true, shutdown: () => provider.shutdown() };
}
