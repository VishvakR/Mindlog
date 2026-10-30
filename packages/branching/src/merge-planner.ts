import type { PnCounter } from './crdt.js';
import {
  EMPTY_COUNTER,
  EMPTY_SET,
  addElement,
  addTo,
  counterValue,
  mergeCounter,
  mergeLww,
  mergeSet,
  setValue,
} from './crdt.js';

// The branch merge planner (PLAN 13.1, ADR-0013): a pure function of what the
// leader read, so the plan it puts in `BranchMerge` is reproducible.

export const MERGE_POLICIES = ['abort', 'raise', 'prefer_branch', 'prefer_main'] as const;
export type MergePolicy = (typeof MERGE_POLICIES)[number];

/** A fact the branch added, and the main facts NLI found it contradicts. */
export interface AddedFact {
  readonly id: string;
  readonly contradicts: ReadonlyArray<{
    readonly with: string;
    readonly scoreAB: number;
    readonly scoreBA: number;
  }>;
}

/** The fields of a main memory a branch can change. */
export interface Fields {
  readonly expired: boolean;
  readonly trust: string;
  /** World time (ms) its validity ends; 0 while open. */
  readonly validTo: bigint;
}

/** A main memory the branch changed: at the fork, on main now and on the branch, with when each side changed it. */
export interface ChangedRecord {
  readonly id: string;
  readonly fork: Fields;
  readonly main: Fields;
  readonly mainHlc: bigint;
  readonly branch: Fields;
  readonly branchHlc: bigint;
}

/** An entity edge the branch wrote: main's current state and the branch's own contribution. */
export interface EdgeChange {
  readonly key: string;
  readonly main: { readonly weight: number; readonly memories: readonly string[] };
  readonly branch: { readonly weight: number; readonly memories: readonly string[] };
}

export interface MergeInput {
  readonly branch: string;
  readonly policy: MergePolicy;
  readonly adds: readonly AddedFact[];
  readonly records: readonly ChangedRecord[];
  readonly edges: readonly EdgeChange[];
  /** Supporting memories an edge keeps (the newest). */
  readonly edgeSupport: number;
}

export interface PlannedConflict {
  readonly a: string;
  readonly b: string;
  readonly scoreAB: number;
  readonly scoreBA: number;
  /** Settled by the policy (`prefer_branch`), else open for review. */
  readonly resolved: boolean;
}

export interface MergePlan {
  /** `abort` found contradictions: nothing is applied. */
  readonly aborted: boolean;
  readonly adds: ReadonlyArray<{ readonly id: string; readonly quarantine: boolean }>;
  /** Branch facts left out (`prefer_main`). */
  readonly rejected: readonly string[];
  readonly conflicts: readonly PlannedConflict[];
  /** Main facts whose validity ends because a branch fact won. */
  readonly supersede: readonly string[];
  /** Main memories whose fields change. */
  readonly records: ReadonlyArray<{ readonly id: string; readonly fields: Fields }>;
  /** Edges with their merged weight and supporting memories. */
  readonly edges: ReadonlyArray<{
    readonly key: string;
    readonly weight: number;
    readonly memories: readonly string[];
  }>;
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** One field, three-way: a side that changed it wins; when both did, the later write (LWW). */
function field<T>(c: ChangedRecord, branch: string, pick: (f: Fields) => T): T {
  const fork = pick(c.fork);
  const main = pick(c.main);
  const ours = pick(c.branch);
  if (ours === fork) return main;
  if (main === fork) return ours;
  return mergeLww(
    { value: main, hlc: c.mainHlc, by: 'main' },
    { value: ours, hlc: c.branchHlc, by: branch },
  ).value;
}

function mergeRecords(input: MergeInput): MergePlan['records'] {
  const out: Array<{ id: string; fields: Fields }> = [];
  for (const c of [...input.records].sort(byId)) {
    const fields: Fields = {
      expired: field(c, input.branch, (f) => f.expired),
      trust: field(c, input.branch, (f) => f.trust),
      validTo: field(c, input.branch, (f) => f.validTo),
    };
    const same =
      fields.expired === c.main.expired &&
      fields.trust === c.main.trust &&
      fields.validTo === c.main.validTo;
    if (!same) out.push({ id: c.id, fields });
  }
  return out;
}

function mergeEdges(input: MergeInput): MergePlan['edges'] {
  return [...input.edges]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((e) => {
      const main: PnCounter = addTo(EMPTY_COUNTER, 'main', e.main.weight);
      const ours: PnCounter = addTo(EMPTY_COUNTER, input.branch, e.branch.weight);
      let memories = EMPTY_SET;
      for (const m of e.main.memories) memories = addElement(memories, m, `main:${m}`);
      let branchSet = EMPTY_SET;
      for (const m of e.branch.memories)
        branchSet = addElement(branchSet, m, `${input.branch}:${m}`);
      memories = mergeSet(memories, branchSet);
      return {
        key: e.key,
        weight: counterValue(mergeCounter(main, ours)),
        // Ids are ULIDs, so the sorted set ends with the newest.
        memories: setValue(memories).slice(-input.edgeSupport),
      };
    });
}

/**
 * The merge of a branch into main: field changes as CRDTs, and the branch's
 * new facts under the merge policy where they contradict main. A
 * contradiction with a main fact the branch itself forgot is no conflict.
 */
export function planMerge(input: MergeInput): MergePlan {
  const records = mergeRecords(input);
  const replaced = new Set(input.records.filter((r) => r.branch.expired).map((r) => r.id));
  const adds: Array<{ id: string; quarantine: boolean }> = [];
  const rejected: string[] = [];
  const conflicts: PlannedConflict[] = [];
  const supersede = new Set<string>();
  for (const add of [...input.adds].sort(byId)) {
    const against = add.contradicts.filter((c) => !replaced.has(c.with));
    if (against.length === 0) {
      adds.push({ id: add.id, quarantine: false });
      continue;
    }
    if (input.policy === 'prefer_main') {
      rejected.push(add.id);
      continue;
    }
    const preferBranch = input.policy === 'prefer_branch';
    adds.push({ id: add.id, quarantine: !preferBranch });
    for (const c of against) {
      conflicts.push({
        a: c.with,
        b: add.id,
        scoreAB: c.scoreAB,
        scoreBA: c.scoreBA,
        resolved: preferBranch,
      });
      if (preferBranch) supersede.add(c.with);
    }
  }
  const aborted = input.policy === 'abort' && conflicts.length > 0;
  return {
    aborted,
    adds: aborted ? [] : adds,
    rejected,
    conflicts,
    supersede: aborted ? [] : [...supersede].sort(),
    records: aborted ? [] : records,
    edges: aborted ? [] : mergeEdges(input),
  };
}
