import type { LogFields, Logger } from './logger.js';

type KeptLevel = 'info' | 'warn' | 'error' | 'fatal';

export interface RecentLog {
  readonly atMs: number;
  readonly level: KeptLevel;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

const SECRET_FIELD = /pass|secret|token|key|authorization|cookie/i;

function safeFields(fields: LogFields | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (SECRET_FIELD.test(name)) continue;
    out[name] = typeof value === 'bigint' ? value.toString() : value;
  }
  return out;
}

/**
 * Keeps the latest log entries for the dashboard (PLAN 17), bounded, with any
 * field that could hold a secret dropped, then passes every entry on.
 */
export class RecentLogs implements Logger {
  readonly #entries: RecentLog[];

  constructor(
    private readonly inner: Logger,
    private readonly now: () => number,
    private readonly capacity = 500,
    entries: RecentLog[] = [],
  ) {
    this.#entries = entries;
  }

  #keep(level: KeptLevel, message: string, fields?: LogFields): void {
    this.#entries.push({ atMs: this.now(), level, message, fields: safeFields(fields) });
    if (this.#entries.length > this.capacity) this.#entries.shift();
  }

  trace(message: string, fields?: LogFields): void {
    this.inner.trace(message, fields);
  }
  debug(message: string, fields?: LogFields): void {
    this.inner.debug(message, fields);
  }
  fatal(message: string, fields?: LogFields): void {
    this.#keep('fatal', message, fields);
    this.inner.fatal(message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#keep('info', message, fields);
    this.inner.info(message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#keep('warn', message, fields);
    this.inner.warn(message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#keep('error', message, fields);
    this.inner.error(message, fields);
  }
  child(fields: LogFields): Logger {
    return new RecentLogs(this.inner.child(fields), this.now, this.capacity, this.#entries);
  }

  /** Newest first. */
  recent(limit: number): RecentLog[] {
    return this.#entries.slice(-limit).reverse();
  }
}
