/**
 * @mindlog/branching — merging memory branches (PLAN 13.1, ADR-0013):
 * state-based CRDTs and the pure merge planner. Reading the branch and main,
 * and applying the plan, are `@mindlog/memory`'s.
 */
export type { Lww, OrSet, PnCounter } from './crdt.js';
export {
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
} from './crdt.js';
export type {
  AddedFact,
  ChangedRecord,
  EdgeChange,
  Fields,
  MergeInput,
  MergePlan,
  MergePolicy,
  PlannedConflict,
} from './merge-planner.js';
export { MERGE_POLICIES, planMerge } from './merge-planner.js';
