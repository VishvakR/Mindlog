/**
 * @mindlog/core — shared foundations for every Mindlog package (PLAN 4.2).
 * Exports only the public API; each module is added as it lands.
 */
export type { Err, Ok, Result } from './result/result.js';
export { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from './result/result.js';

export type { ErrorCodeSpec, McpErrorKind } from './errors/error-codes.js';
export { ERROR_CODES, GrpcStatus, MindlogErrorCode, problemType } from './errors/error-codes.js';
export type { ErrorDetailView, MindlogError, MindlogErrorOptions } from './errors/mindlog-error.js';
export { errorSpec, isRetryable, mindlogError, toErrorDetail } from './errors/mindlog-error.js';

export type { Clock } from './clock/clock.js';
export { ManualClock } from './clock/manual-clock.js';
export { SystemClock } from './clock/system-clock.js';

export type { Random } from './random/random.js';
export { SeededRandom } from './random/seeded-random.js';
export { SystemRandom } from './random/system-random.js';

export { UlidGenerator, isUlid, ulidTime } from './ids/ulid.js';

export type { Hlc, HlcOptions } from './hlc/hlc.js';
export { HybridLogicalClock, hlcLogical, hlcPhysical, packHlc } from './hlc/hlc.js';
export type { ClockSyncOptions } from './hlc/clock-sync.js';
export { ClockSync } from './hlc/clock-sync.js';

export { ByteWriter } from './keys/byte-writer.js';
export { TupleCode } from './keys/tuple-codes.js';
export type { Tuple, TupleElement } from './keys/tuple.js';
export { appendTuple, encodeTuple } from './keys/tuple.js';
export { VERSION_SUFFIX_LENGTH, appendVersion } from './keys/version.js';
export type { DecodedTuple } from './keys/decode-tuple.js';
export { decodeTuple } from './keys/decode-tuple.js';
export type { KeyParts, KeyRange } from './keys/key.js';
export {
  KeyFamily,
  NODE_TENANT,
  SYSTEM_TENANT,
  decodeKey,
  isUserTenant,
  encodeKey,
  keyPrefix,
  prefixRange,
  versionsRange,
} from './keys/key.js';

export type { ConfigOverrides, LogLevel, MindlogConfig } from './config/config-schema.js';
export { configSchema } from './config/config-schema.js';
export type { ConfigSources } from './config/resolve-config.js';
export { resolveConfig } from './config/resolve-config.js';

export type { LogFields, Logger } from './logging/logger.js';
export { LOG_LEVELS } from './logging/logger.js';
export type { LogEntry } from './logging/memory-logger.js';
export { MemoryLogger } from './logging/memory-logger.js';
export type { LoggerOptions } from './logging/pino-logger.js';
export { createLogger } from './logging/pino-logger.js';

export type {
  Counter,
  Gauge,
  Histogram,
  HistogramOptions,
  Labels,
  MetricKind,
  MetricOptions,
  Metrics,
} from './metrics/metrics.js';
export { assertMetricName } from './metrics/metrics.js';
export { MemoryMetrics } from './metrics/memory-metrics.js';
export { PromMetrics } from './metrics/prom-metrics.js';

export type { SpanAttributeValue, SpanAttributes, SpanHandle, Tracer } from './tracing/tracer.js';
export { OtelTracer } from './tracing/otel-tracer.js';
export type { TracingHandle, TracingOptions } from './tracing/init-tracing.js';
export { initTracing } from './tracing/init-tracing.js';

export type { ScopePath } from './scope/scope-path.js';

export { crc32c } from './checksum/crc32c.js';
