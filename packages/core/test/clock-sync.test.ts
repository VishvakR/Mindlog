import { describe, expect, test } from 'vitest';
import {
  ClockSync,
  ManualClock,
  MemoryLogger,
  MemoryMetrics,
  hlcPhysical,
  packHlc,
} from '@mindlog/core';

function make(startMs = 1_000_000n) {
  const clock = new ManualClock(startMs);
  const metrics = new MemoryMetrics();
  const logger = new MemoryLogger();
  const sync = new ClockSync({ clock, maxOffsetMs: 500n, holdMs: 2000, metrics, logger });
  return { clock, metrics, logger, sync };
}

describe('ClockSync', () => {
  test('merges the HLC of messages from peers with a normal offset', () => {
    const { sync, metrics } = make();
    sync.receive('n2', packHlc(1_000_200n, 3n));
    expect(sync.fenced).toBe(false);
    expect(hlcPhysical(sync.stamp())).toBeGreaterThanOrEqual(1_000_200n);
    expect(metrics.value('mindlog_clock_offset_seconds', { peer: 'n2' })).toBeCloseTo(0.2);
  });

  test.each([
    ['ahead', 1_000_000n + 900n],
    ['behind', 1_000_000n - 900n],
  ])('a peer %s by more than the maximum offset fences the node for the hold time', (_, at) => {
    const { sync, clock, metrics, logger } = make();
    sync.receive('n2', packHlc(at, 0n));
    expect(sync.fenced).toBe(true);
    expect(metrics.value('mindlog_clock_fenced_info')).toBe(1);
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
    clock.advance(1999n);
    expect(sync.fenced).toBe(true);
    clock.advance(2n);
    expect(sync.fenced).toBe(false);
    expect(metrics.value('mindlog_clock_fenced_info')).toBe(0);
  });

  test('applied commands from the past never fence, and zero is ignored', () => {
    const { sync } = make();
    sync.observe(packHlc(5n, 0n));
    sync.receive('n2', packHlc(0n, 0n));
    expect(sync.fenced).toBe(false);
  });
});
