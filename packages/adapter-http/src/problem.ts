import type { MindlogError } from '@mindlog/core';
import { ERROR_CODES, problemType } from '@mindlog/core';

/** RFC 9457 problem details, from the one error table in core (CLAUDE.md §9). */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly fields?: Readonly<Record<string, string>>;
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export function toProblem(error: MindlogError): Problem {
  const spec = ERROR_CODES[error.code];
  return {
    type: problemType(error.code),
    title: spec.title,
    status: spec.httpStatus,
    detail: error.message,
    code: error.code,
    retryable: spec.retryable,
    ...(error.fields ? { fields: error.fields } : {}),
  };
}
