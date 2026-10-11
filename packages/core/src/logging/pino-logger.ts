import type { DestinationStream, Logger as PinoInstance } from 'pino';
import { pino, stdTimeFunctions } from 'pino';
import type { LogLevel } from '../config/config-schema.js';
import type { LogFields, Logger } from './logger.js';
import { DEFAULT_REDACT_PATHS, REDACTED, stringifyBigInts } from './redaction.js';

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Service or module name added to every entry. */
  readonly name?: string;
  /** Where JSON lines go; defaults to stdout. */
  readonly destination?: DestinationStream;
  /** Extra redact paths on top of the defaults. */
  readonly redact?: readonly string[];
}

/** Production Logger: JSON lines via pino, ISO timestamps, secrets redacted. */
export function createLogger(options: LoggerOptions): Logger {
  const instance = pino(
    {
      level: options.level,
      ...(options.name === undefined ? {} : { name: options.name }),
      timestamp: stdTimeFunctions.isoTime,
      redact: { paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])], censor: REDACTED },
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => stringifyBigInts(bindings) as Record<string, unknown>,
        log: (entry) => stringifyBigInts(entry) as Record<string, unknown>,
      },
    },
    options.destination,
  );
  return new PinoLogger(instance);
}

class PinoLogger implements Logger {
  readonly #pino: PinoInstance;

  constructor(instance: PinoInstance) {
    this.#pino = instance;
  }

  trace(message: string, fields: LogFields = {}): void {
    this.#pino.trace(fields, message);
  }

  debug(message: string, fields: LogFields = {}): void {
    this.#pino.debug(fields, message);
  }

  info(message: string, fields: LogFields = {}): void {
    this.#pino.info(fields, message);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.#pino.warn(fields, message);
  }

  error(message: string, fields: LogFields = {}): void {
    this.#pino.error(fields, message);
  }

  fatal(message: string, fields: LogFields = {}): void {
    this.#pino.fatal(fields, message);
  }

  child(bindings: LogFields): Logger {
    // pino serialises child bindings without the `log` formatter.
    return new PinoLogger(this.#pino.child(stringifyBigInts(bindings) as LogFields));
  }
}
