import { describe, expect, test } from 'vitest';
import type { Hlc } from '@mindlog/core';
import {
  HybridLogicalClock,
  ManualClock,
  SeededRandom,
  UlidGenerator,
  hlcPhysical,
  isUlid,
} from '@mindlog/core';
import { CommandStamper } from '@mindlog/statemachine';

describe('CommandStamper', () => {
  test('stamps a ULID request id, the HLC time, tenant, principal and body', () => {
    const clock = new ManualClock(1_760_000_000_000n);
    const stamper = new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, new SeededRandom(1n)),
    );
    const a = stamper.stamp('acme', 'user:1', {
      case: 'kvWrite',
      value: { argv: [Uint8Array.of(1)] },
    });
    const b = stamper.stamp('acme', 'user:1', { case: 'kvWrite', value: { argv: [] } });
    expect(isUlid(new TextDecoder().decode(a.requestId))).toBe(true);
    expect(a.requestId).not.toEqual(b.requestId);
    expect(hlcPhysical(a.hlc as Hlc)).toBe(1_760_000_000_000n);
    expect(b.hlc).toBeGreaterThan(a.hlc);
    expect([a.tenant, a.principal, a.body.case]).toEqual(['acme', 'user:1', 'kvWrite']);
  });

  test('keeps a caller-supplied request id for retries', () => {
    const clock = new ManualClock();
    const stamper = new CommandStamper(
      new HybridLogicalClock(clock, { maxOffsetMs: 500n }),
      new UlidGenerator(clock, new SeededRandom(1n)),
    );
    const id = Uint8Array.of(7, 7);
    expect(stamper.stamp('t', 'p', { case: 'expire', value: {} }, id).requestId).toEqual(id);
  });
});
