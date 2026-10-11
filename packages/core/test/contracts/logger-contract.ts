import { describe, expect, test } from 'vitest';
import type { LogFields, Logger } from '@mindlog/core';

export interface CapturedEntry {
  readonly level: string;
  readonly message: string;
  readonly fields: LogFields;
}

export interface LoggerHarness {
  readonly logger: Logger;
  entries(): CapturedEntry[];
}

/** Behaviour every Logger implementation must have. */
export function describeLoggerContract(
  name: string,
  make: (level: 'trace' | 'info' | 'warn') => LoggerHarness,
): void {
  describe(`Logger contract: ${name}`, () => {
    test('records message, level and fields', () => {
      const h = make('trace');
      h.logger.info('started', { port: 6379 });
      expect(h.entries()).toMatchObject([
        { level: 'info', message: 'started', fields: { port: 6379 } },
      ]);
    });

    test('drops entries below the configured level', () => {
      const h = make('warn');
      h.logger.info('quiet');
      h.logger.error('loud');
      expect(h.entries().map((e) => e.message)).toEqual(['loud']);
    });

    test('child loggers carry their bindings', () => {
      const h = make('trace');
      h.logger.child({ traceId: 't-1', tenant: 'acme' }).child({ rangeId: 9n }).warn('slow');
      const fields = h.entries()[0]?.fields ?? {};
      expect(fields).toMatchObject({ traceId: 't-1', tenant: 'acme' });
      expect(String(fields['rangeId'])).toBe('9');
    });
  });
}
