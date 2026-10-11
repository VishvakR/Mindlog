import type { ErrorCodeSpec, MindlogErrorCode } from './error-codes.js';
import { ERROR_CODES } from './error-codes.js';

/**
 * An expected failure, carried in `Result` rather than thrown. `message` and
 * `fields` are public-safe; `cause` is for logs only and never serialised to
 * clients (pattern from PocketBase's ApiError rawData vs Data).
 */
export interface MindlogError {
  readonly code: MindlogErrorCode;
  readonly message: string;
  /** Per-field validation messages keyed by field path, e.g. `listen.resp.port`. */
  readonly fields?: Readonly<Record<string, string>>;
  /** Server-suggested wait before retrying, for BUSY / RATE_LIMITED. */
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export interface MindlogErrorOptions {
  readonly fields?: Readonly<Record<string, string>>;
  readonly retryAfterMs?: number;
  readonly cause?: unknown;
}

export function mindlogError(
  code: MindlogErrorCode,
  message: string,
  options: MindlogErrorOptions = {},
): MindlogError {
  return { code, message, ...options };
}

export function errorSpec(code: MindlogErrorCode): ErrorCodeSpec {
  return ERROR_CODES[code];
}

export function isRetryable(error: MindlogError): boolean {
  return ERROR_CODES[error.code].retryable;
}

/** Public, serialisable view (matches proto `mindlog.v1.ErrorDetail`); drops `cause`. */
export interface ErrorDetailView {
  readonly code: MindlogErrorCode;
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly retryable: boolean;
}

export function toErrorDetail(error: MindlogError): ErrorDetailView {
  return {
    code: error.code,
    message: error.message,
    fields: error.fields ?? {},
    retryable: isRetryable(error),
  };
}
