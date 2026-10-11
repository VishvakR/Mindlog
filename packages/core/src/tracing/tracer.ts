export type SpanAttributeValue = string | number | boolean | bigint;
export type SpanAttributes = Readonly<Record<string, SpanAttributeValue>>;

/** The part of a span that instrumented code may touch. */
export interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue): void;
}

/**
 * Tracing port (CLAUDE.md §13). `withSpan` opens a span around `fn`, makes it
 * the active span for nested calls, marks it failed when `fn` throws or
 * returns an `Err` result, and always ends it.
 */
export interface Tracer {
  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
}
