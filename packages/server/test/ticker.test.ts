import { MemoryLogger } from '@mindlog/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ticker } from '../src/bootstrap/ticker.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('a slow tick is not doubled, and stop waits for it', async () => {
  let started = 0;
  let finish = () => {};
  const t = ticker(
    'slow',
    () => {
      started++;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    10,
    new MemoryLogger(),
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(started).toBe(1);
  let stopped = false;
  const stopping = t.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(stopped).toBe(false);
  finish();
  await stopping;
  await vi.advanceTimersByTimeAsync(50);
  expect(started).toBe(1);
});

test('a failed tick is logged and the next one still runs', async () => {
  const logger = new MemoryLogger();
  let calls = 0;
  const t = ticker(
    'flaky',
    () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('store closed')) : Promise.resolve();
    },
    10,
    logger,
  );
  await vi.advanceTimersByTimeAsync(25);
  expect(calls).toBe(2);
  expect(logger.entries.some((e) => e.message === 'flaky tick failed')).toBe(true);
  await t.stop();
});
