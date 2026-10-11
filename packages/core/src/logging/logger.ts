/** Structured fields attached to a log entry. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Logging port (CLAUDE.md §13). Entries are structured; the request path binds
 * `traceId`, `tenant` and `rangeId` through `child()`. Secrets are redacted
 * by the implementation, never by callers.
 */
export interface Logger {
  trace(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  fatal(message: string, fields?: LogFields): void;
  /** Logger whose entries all carry `bindings`. */
  child(bindings: LogFields): Logger;
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
