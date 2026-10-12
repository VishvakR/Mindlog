import { describe, expect, test } from 'vitest';
import { ERROR_CODES, MindlogErrorCode, mindlogError } from '@mindlog/core';
import { toProblem } from '@mindlog/adapter-http';

describe('toProblem', () => {
  test.each(Object.values(MindlogErrorCode))('%s maps through the core error table', (code) => {
    const problem = toProblem(mindlogError(code, 'detail text'));
    expect(problem).toEqual({
      type: `urn:mindlog:error:${code.toLowerCase().replaceAll('_', '-')}`,
      title: ERROR_CODES[code].title,
      status: ERROR_CODES[code].httpStatus,
      detail: 'detail text',
      code,
      retryable: ERROR_CODES[code].retryable,
    });
  });

  test('carries field errors but never the cause', () => {
    const problem = toProblem(
      mindlogError('INVALID_ARGUMENT', 'bad', {
        fields: { a: 'required' },
        cause: new Error('secret'),
      }),
    );
    expect(problem.fields).toEqual({ a: 'required' });
    expect(JSON.stringify(problem)).not.toContain('secret');
  });
});
