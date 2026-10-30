import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import type { Lww, OrSet, PnCounter } from '@mindlog/branching';
import {
  EMPTY_COUNTER,
  EMPTY_SET,
  addElement,
  addTo,
  counterValue,
  mergeCounter,
  mergeLww,
  mergeSet,
  removeElement,
  setValue,
} from '@mindlog/branching';

const writer = fc.constantFrom('main', 'plan', 'dream');
const element = fc.constantFrom('m1', 'm2', 'm3', 'm4');

const counter: fc.Arbitrary<PnCounter> = fc
  .array(fc.tuple(writer, fc.integer({ min: -5, max: 5 })), { maxLength: 6 })
  .map((ops) => ops.reduce((c, [by, d]) => addTo(c, by, d), EMPTY_COUNTER));

const orSet: fc.Arbitrary<OrSet> = fc
  .array(fc.tuple(fc.boolean(), element, fc.nat({ max: 9 })), { maxLength: 8 })
  .map((ops) =>
    ops.reduce(
      (s, [add, e, tag]) => (add ? addElement(s, e, `t${String(tag)}`) : removeElement(s, e)),
      EMPTY_SET,
    ),
  );

const register: fc.Arbitrary<Lww<string>> = fc.record({
  value: fc.string({ maxLength: 3 }),
  hlc: fc.bigInt({ min: 0n, max: 5n }),
  by: writer,
});

/** The three state-based CRDT laws for a merge. */
function laws<T>(name: string, arb: fc.Arbitrary<T>, merge: (a: T, b: T) => T) {
  describe(name, () => {
    test('commutative', () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => {
          expect(merge(a, b)).toEqual(merge(b, a));
        }),
      );
    });
    test('associative', () => {
      fc.assert(
        fc.property(arb, arb, arb, (a, b, c) => {
          expect(merge(merge(a, b), c)).toEqual(merge(a, merge(b, c)));
        }),
      );
    });
    test('idempotent', () => {
      fc.assert(
        fc.property(arb, arb, (a, b) => {
          expect(merge(merge(a, b), b)).toEqual(merge(a, b));
        }),
      );
    });
  });
}

laws('PN-counter', counter, mergeCounter);
laws('OR-set', orSet, mergeSet);
// Registers with equal (hlc, by) must carry equal values, as one write does.
laws(
  'LWW register',
  register.map((r) => ({ ...r, value: `${r.by}@${String(r.hlc)}` })),
  mergeLww,
);

describe('CRDT semantics', () => {
  test('a counter merge keeps both sides’ increments', () => {
    const main = addTo(EMPTY_COUNTER, 'main', 3);
    const branch = addTo(addTo(EMPTY_COUNTER, 'main', 2), 'plan', 4);
    expect(counterValue(mergeCounter(main, branch))).toBe(7);
  });

  test('an add the remover did not see survives the remove (add wins)', () => {
    const seen = addElement(EMPTY_SET, 'm1', 'a');
    const removed = removeElement(seen, 'm1');
    const concurrent = addElement(seen, 'm1', 'b');
    expect(setValue(mergeSet(removed, concurrent))).toEqual(['m1']);
    expect(setValue(mergeSet(removed, seen))).toEqual([]);
  });

  test('the later write wins a register; the writer breaks ties', () => {
    expect(mergeLww({ value: 'x', hlc: 2n, by: 'a' }, { value: 'y', hlc: 1n, by: 'z' }).value).toBe(
      'x',
    );
    expect(mergeLww({ value: 'x', hlc: 1n, by: 'a' }, { value: 'y', hlc: 1n, by: 'b' }).value).toBe(
      'y',
    );
  });
});
