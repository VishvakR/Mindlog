/**
 * Phase 0 exit gate (PLAN 24): byte-wise order of encoded keys equals the
 * semantic order of their tuples, for 100k random tuples. The oracle below is
 * written from the spec (FDB tuple `compare`), independently of the encoder.
 */
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Tuple, TupleElement } from '@mindlog/core';
import { encodeKey } from '@mindlog/core';
import { compareBytes, compareDoubles, tuple, unwrap } from './helpers.js';

const GATE_TUPLES = 100_000;
const utf8 = new TextEncoder();

function typeRank(e: TupleElement): number {
  if (e === null) return 0;
  if (e instanceof Uint8Array) return 1;
  if (typeof e === 'string') return 2;
  if (typeof e === 'bigint') return 3;
  if (typeof e === 'number') return 4;
  return 5;
}

function compareElements(a: TupleElement, b: TupleElement): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return compareBytes(a, b);
  if (typeof a === 'string' && typeof b === 'string') {
    return compareBytes(utf8.encode(a), utf8.encode(b));
  }
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'number' && typeof b === 'number') return compareDoubles(a, b);
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return 0;
}

function compareTuples(a: Tuple, b: Tuple): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = compareElements(a[i] ?? null, b[i] ?? null);
    if (c !== 0) return c;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

const key = (t: Tuple) => unwrap(encodeKey({ tenant: 'gate', family: 'k', tuple: t }));

/** Pairs that share a random prefix, so comparisons reach deep elements. */
const tuplePair = fc.tuple(tuple, tuple, tuple).map(
  ([prefix, x, y]) =>
    [
      [...prefix, ...x],
      [...prefix, ...y],
    ] as const,
);

describe('key encoding order (phase 0 gate)', () => {
  test(`pairwise: byte order equals tuple order for ${GATE_TUPLES} random pairs`, () => {
    fc.assert(
      fc.property(tuplePair, ([a, b]) => {
        expect(compareBytes(key(a), key(b))).toBe(compareTuples(a, b));
      }),
      { numRuns: GATE_TUPLES },
    );
  }, 120_000);

  test(`sorting ${GATE_TUPLES} random tuples by bytes equals sorting by tuple order`, () => {
    const tuples = fc.sample(tuple, { numRuns: GATE_TUPLES, seed: 20_261_011 });
    const encoded = tuples.map((t) => ({ t, k: key(t) }));
    const byBytes = [...encoded].sort((x, y) => compareBytes(x.k, y.k));
    for (let i = 1; i < byBytes.length; i++) {
      const prev = byBytes[i - 1];
      const curr = byBytes[i];
      if (prev && curr) expect(compareTuples(prev.t, curr.t)).toBeLessThanOrEqual(0);
    }
  }, 120_000);
});
