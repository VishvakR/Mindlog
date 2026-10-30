// State-based CRDTs for branch merges (PLAN 13.1, ADR-0013): every merge is
// commutative, associative and idempotent, so main and a branch merge to the
// same state in any order. Canonical forms (sorted, deduplicated) keep the
// merged values byte-identical on every replica.

/** Last-writer-wins register: the write with the greatest `(hlc, by)` wins. */
export interface Lww<T> {
  readonly value: T;
  readonly hlc: bigint;
  /** Tie-breaker: who wrote it (a replica or branch name, or a request id). */
  readonly by: string;
}

export function mergeLww<T>(a: Lww<T>, b: Lww<T>): Lww<T> {
  return a.hlc > b.hlc || (a.hlc === b.hlc && a.by >= b.by) ? a : b;
}

/** PN-counter: increments and decrements per writer; a merge keeps each writer's maximum. */
export interface PnCounter {
  readonly inc: Readonly<Record<string, number>>;
  readonly dec: Readonly<Record<string, number>>;
}

export const EMPTY_COUNTER: PnCounter = { inc: {}, dec: {} };

/** A counter where `by` has added `delta` (negative to subtract) on top of `c`. */
export function addTo(c: PnCounter, by: string, delta: number): PnCounter {
  const side = delta >= 0 ? 'inc' : 'dec';
  return { ...c, [side]: { ...c[side], [by]: (c[side][by] ?? 0) + Math.abs(delta) } };
}

function maxEach(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort())
    out[k] = Math.max(a[k] ?? 0, b[k] ?? 0);
  return out;
}

export function mergeCounter(a: PnCounter, b: PnCounter): PnCounter {
  return { inc: maxEach(a.inc, b.inc), dec: maxEach(a.dec, b.dec) };
}

export function counterValue(c: PnCounter): number {
  const sum = (r: Readonly<Record<string, number>>) => Object.values(r).reduce((x, y) => x + y, 0);
  return sum(c.inc) - sum(c.dec);
}

/**
 * Add-wins observed-remove set: each add carries a unique tag; a remove
 * names the tags it saw, so a concurrent add (a new tag) survives it.
 */
export interface OrSet {
  /** `[element, tag]` pairs, sorted. */
  readonly adds: ReadonlyArray<readonly [string, string]>;
  /** Removed tags, sorted. */
  readonly removed: readonly string[];
}

export const EMPTY_SET: OrSet = { adds: [], removed: [] };

const pairKey = ([e, t]: readonly [string, string]) => `${e}\u0000${t}`;

export function addElement(s: OrSet, element: string, tag: string): OrSet {
  return mergeSet(s, { adds: [[element, tag]], removed: [] });
}

/** Removes `element` as this replica sees it: every tag it has observed. */
export function removeElement(s: OrSet, element: string): OrSet {
  const tags = s.adds.filter(([e]) => e === element).map(([, t]) => t);
  return mergeSet(s, { adds: [], removed: tags });
}

export function mergeSet(a: OrSet, b: OrSet): OrSet {
  const adds = new Map<string, readonly [string, string]>();
  for (const p of [...a.adds, ...b.adds]) adds.set(pairKey(p), p);
  return {
    adds: [...adds.values()].sort((x, y) => (pairKey(x) < pairKey(y) ? -1 : 1)),
    removed: [...new Set([...a.removed, ...b.removed])].sort(),
  };
}

/** The elements present: added under some tag that no remove has seen. */
export function setValue(s: OrSet): string[] {
  const removed = new Set(s.removed);
  return [...new Set(s.adds.filter(([, t]) => !removed.has(t)).map(([e]) => e))].sort();
}
