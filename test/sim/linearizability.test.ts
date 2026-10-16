import { describe, expect, test } from 'vitest';
import type { RegisterOp } from './linearizability.js';
import { checkRegister } from './linearizability.js';

const op = (o: Partial<RegisterOp> & Pick<RegisterOp, 'kind' | 'invoke'>): RegisterOp => ({
  value: null,
  outcome: 'ok',
  complete: o.invoke + 1,
  ...o,
});

describe('checkRegister (Wing–Gong)', () => {
  test('accepts sequential and overlapping histories that have an order', () => {
    expect(
      checkRegister([
        op({ kind: 'write', value: 'a', invoke: 0 }),
        op({ kind: 'read', value: 'a', invoke: 2 }),
        op({ kind: 'cas', from: 'a', value: 'b', invoke: 4 }),
        op({ kind: 'read', value: 'b', invoke: 6 }),
      ]),
    ).toBeUndefined();
    // Concurrent write and read: the read may see either value.
    expect(
      checkRegister([
        op({ kind: 'write', value: 'x', invoke: 0, complete: 10 }),
        op({ kind: 'read', value: null, invoke: 1, complete: 2 }),
        op({ kind: 'read', value: 'x', invoke: 3, complete: 4 }),
      ]),
    ).toBeUndefined();
  });

  test('rejects a stale read after a completed write', () => {
    expect(
      checkRegister([
        op({ kind: 'write', value: 'a', invoke: 0, complete: 1 }),
        op({ kind: 'read', value: null, invoke: 2, complete: 3 }),
      ]),
    ).toBeDefined();
  });

  test('unknown writes may or may not have happened, but not both ways', () => {
    const lost = op({
      kind: 'write',
      value: 'u',
      invoke: 0,
      outcome: 'unknown',
      complete: Infinity,
    });
    expect(checkRegister([lost, op({ kind: 'read', value: null, invoke: 5 })])).toBeUndefined();
    expect(checkRegister([lost, op({ kind: 'read', value: 'u', invoke: 5 })])).toBeUndefined();
    expect(
      checkRegister([
        lost,
        op({ kind: 'read', value: 'u', invoke: 5 }),
        op({ kind: 'read', value: null, invoke: 7 }),
      ]),
    ).toBeDefined();
  });

  test('a failed cas observed a different value', () => {
    expect(
      checkRegister([
        op({ kind: 'write', value: 'a', invoke: 0 }),
        op({ kind: 'cas', from: 'a', value: 'b', outcome: 'fail', invoke: 2 }),
      ]),
    ).toBeDefined();
    expect(
      checkRegister([
        op({ kind: 'write', value: 'a', invoke: 0 }),
        op({ kind: 'cas', from: 'z', value: 'b', outcome: 'fail', invoke: 2 }),
      ]),
    ).toBeUndefined();
  });
});
