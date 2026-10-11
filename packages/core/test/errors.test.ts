import { describe, expect, test } from 'vitest';
import {
  ERROR_CODES,
  GrpcStatus,
  MindlogErrorCode,
  errorSpec,
  isRetryable,
  mindlogError,
  problemType,
  toErrorDetail,
} from '@mindlog/core';

const codes = Object.values(MindlogErrorCode);

describe('error code table', () => {
  test('every code has exactly one spec and no spec is orphaned', () => {
    expect(Object.keys(ERROR_CODES).sort()).toEqual([...codes].sort());
  });

  test.each(codes)('%s maps to valid replies on every interface', (code) => {
    const spec = errorSpec(code);
    expect(spec.resp).toMatch(/^[A-Z]+$/);
    expect(spec.httpStatus).toBeGreaterThanOrEqual(400);
    expect(spec.httpStatus).toBeLessThan(600);
    expect(Object.values(GrpcStatus)).toContain(spec.grpcStatus);
    expect(['invalid_params', 'tool_error']).toContain(spec.mcp);
    expect(spec.title.length).toBeGreaterThan(0);
  });

  test('problem types are unique URNs', () => {
    const types = codes.map(problemType);
    expect(new Set(types).size).toBe(codes.length);
    expect(problemType('WRONG_TYPE')).toBe('urn:mindlog:error:wrong-type');
  });

  test('backpressure codes use the RESP prefixes clients branch on', () => {
    expect(errorSpec('BUSY').resp).toBe('BUSY');
    expect(errorSpec('WRONG_TYPE').resp).toBe('WRONGTYPE');
    expect(errorSpec('RANGE_MOVED').resp).toBe('MOVED');
    expect(errorSpec('UNSUPPORTED_PROTOCOL').resp).toBe('NOPROTO');
  });
});

describe('MindlogError', () => {
  test('toErrorDetail exposes public data only', () => {
    const error = mindlogError('CONFIG_INVALID', 'bad config', {
      fields: { 'listen.resp.port': 'must be a port number' },
      cause: new Error('secret internal detail'),
    });
    const detail = toErrorDetail(error);
    expect(detail).toEqual({
      code: 'CONFIG_INVALID',
      message: 'bad config',
      fields: { 'listen.resp.port': 'must be a port number' },
      retryable: false,
    });
    expect(JSON.stringify(detail)).not.toContain('secret');
  });

  test('retryability comes from the table', () => {
    expect(isRetryable(mindlogError('BUSY', 'queue full', { retryAfterMs: 50 }))).toBe(true);
    expect(isRetryable(mindlogError('NOT_FOUND', 'no such key'))).toBe(false);
  });
});
