# @mindlog/branching

Merging memory branches into main (PLAN 13.1, ADR-0013). Pure code with no dependencies: the memory engine reads the branch and main, asks `planMerge` what to do, and proposes the plan in a `BranchMerge` command that every replica applies as data.

## Public API

- **CRDTs** (state-based; every merge is commutative, associative and idempotent):
  - `Lww<T>` and `mergeLww`: last writer wins by `(hlc, by)`.
  - `PnCounter`, `addTo`, `mergeCounter` and `counterValue`: per-writer increments and decrements; a merge keeps each writer's maximum.
  - `OrSet`, `addElement`, `removeElement`, `mergeSet` and `setValue`: an add-wins observed-remove set.
- **`planMerge(input)`** returns a `MergePlan`:
  - **Fields of main memories** the branch changed (`expired`, `trust`, `validTo`) merge three-way against the fork: a side that changed a field wins, and when both did, the later write wins (LWW).
  - **Entity edges** the branch wrote merge as a PN-counter weight (main + branch) and an OR-set of supporting memories, keeping the newest `edgeSupport`.
  - **New branch facts** that contradict main facts follow the policy:
    - `abort`: nothing is applied.
    - `raise`: they are added quarantined, with open conflicts.
    - `prefer_branch`: they are added, the main facts' validity ends, and the conflicts are recorded as resolved.
    - `prefer_main`: they are rejected.
  - A contradiction with a main fact the branch itself forgot is no conflict.

## Invariants

- `planMerge` depends only on its input, not on the order things were read in (property-tested), so the plan in the log is reproducible.
- Plans name ids only; applying them, and checking that main has not moved since the plan was made, is `@mindlog/memory`'s.

## Metrics

None. The memory engine counts merges.
