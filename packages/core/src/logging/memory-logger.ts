import type { LogLevel } from '../config/config-schema.js';
import type { LogFields, Logger } from './logger.js';
import { LOG_LEVELS } from './logger.js';

export interface LogEntry {
  readonly level: LogLevel;
  readonly message: string;
  readonly fields: LogFields;
}

/** In-memory Logger for tests and the simulator; entries are inspectable. */
export class MemoryLogger implements Logger {
  readonly entries: LogEntry[];
  readonly #bindings: LogFields;
  readonly #minLevel: number;

  constructor(level: LogLevel = 'trace', bindings: LogFields = {}, sink: LogEntry[] = []) {
    this.entries = sink;
    this.#bindings = bindings;
    this.#minLevel = LOG_LEVELS.indexOf(level);
  }

  trace(message: string, fields?: LogFields): void {
    this.#log('trace', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.#log('debug', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.#log('info', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.#log('warn', message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.#log('error', message, fields);
  }

  fatal(message: string, fields?: LogFields): void {
    this.#log('fatal', message, fields);
  }

  child(bindings: LogFields): Logger {
    const level = LOG_LEVELS[this.#minLevel] ?? 'trace';
    return new MemoryLogger(level, { ...this.#bindings, ...bindings }, this.entries);
  }

  #log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (LOG_LEVELS.indexOf(level) < this.#minLevel) return;
    this.entries.push({ level, message, fields: { ...this.#bindings, ...fields } });
  }
}
