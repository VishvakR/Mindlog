import { describe, expect, test } from 'vitest';
import { MemoryLogger, createLogger } from '@mindlog/core';
import type { CapturedEntry, LoggerHarness } from './contracts/logger-contract.js';
import { describeLoggerContract } from './contracts/logger-contract.js';

function pinoHarness(level: 'trace' | 'info' | 'warn'): LoggerHarness & { raw: string[] } {
  const raw: string[] = [];
  const logger = createLogger({ level, destination: { write: (line: string) => raw.push(line) } });
  return {
    logger,
    raw,
    entries: (): CapturedEntry[] =>
      raw.map((line) => {
        const {
          level: lvl,
          msg,
          time: _t,
          pid: _p,
          hostname: _h,
          ...fields
        } = JSON.parse(line) as Record<string, unknown>;
        return { level: String(lvl), message: String(msg), fields };
      }),
  };
}

describeLoggerContract('pino logger', pinoHarness);
describeLoggerContract('MemoryLogger', (level) => {
  const logger = new MemoryLogger(level);
  return { logger, entries: () => logger.entries };
});

describe('createLogger', () => {
  test('redacts secrets at any of the first three levels', () => {
    const h = pinoHarness('info');
    h.logger.info('login', {
      password: 'hunter2',
      headers: { authorization: 'Bearer abc' },
      cluster: { auth: { joinToken: 'jt' } },
    });
    const line = h.raw.join('');
    for (const secret of ['hunter2', 'Bearer abc', '"jt"']) expect(line).not.toContain(secret);
    expect(line).toContain('[REDACTED]');
  });

  test('redacts secrets bound on child loggers', () => {
    const h = pinoHarness('info');
    h.logger.child({ apiKey: 'k-123' }).info('call');
    expect(h.raw.join('')).not.toContain('k-123');
  });

  test('keeps full bigint precision as decimal strings', () => {
    const h = pinoHarness('info');
    const hlc = 2n ** 63n + 1n;
    h.logger.child({ rangeId: 7n }).info('applied', { hlc, nested: { index: [1n, 2n] } });
    const entry = JSON.parse(h.raw[0] ?? '{}') as Record<string, unknown>;
    expect(entry['hlc']).toBe(hlc.toString());
    expect(entry['rangeId']).toBe('7');
    expect(entry['nested']).toEqual({ index: ['1', '2'] });
  });

  test('writes ISO timestamps and level labels', () => {
    const h = pinoHarness('info');
    h.logger.info('x');
    const entry = JSON.parse(h.raw[0] ?? '{}') as Record<string, unknown>;
    expect(entry['level']).toBe('info');
    expect(String(entry['time'])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
