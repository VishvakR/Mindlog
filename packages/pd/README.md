# @mindlog/pd

Placement driver (PLAN 8.3, ADR-0010, layer `replication`): the cluster's range directory, id allocator, timestamp oracle, node registry, schedulers and operators.

## Public API

| Export | Purpose |
|---|---|
| `PD_HANDLERS`, `PD_RANGE_ID` | Apply handlers for the PD commands (`pdAllocIds`, `pdPutNode`, `pdPutRange`, `pdRemoveRange`, `pdSetTso`, `pdSetVersion`, `pdRecordOperator`). The PD group is an ordinary Raft group of range 0 over its own stores, so its state rides in Raft snapshots |
| `PdView` | Read side: nodes, ranges, `rangeFor(key)`, TSO bound, cluster version, recent operators |
| `PdService` | Leader-side logic: `allocIds`, `tso`, `getRange`, `scanRanges`, `storeHeartbeat`, `rangeHeartbeat`, `cluster`, `admin`, and a one-second `tick` for the node lifecycle, cluster version and schedulers |
| `Scheduler`, `DEFAULT_SCHEDULERS` | Plugins `schedule(view) → {operators, explanation}`: `repair`, `drain`, `split`, `replica-balance`, `leader-balance`, `merge`. Pure functions of a `ClusterView`, so they are tested without a cluster |
| `OperatorController` | Operators as steps (`add-learner`, `promote`, `transfer-leader`, `remove-voter`, `split`, `merge`), one per range, advanced by observing range heartbeats |

## Invariants

- **Timestamps never repeat or go back.** A new leader reads the persisted bound, issues from above it and above its HLC, and persists a new bound ahead of what it hands out (`tsoWindowMs`, default 3 s). The bound is also kept ahead as timestamps are consumed.
- **PD never changes ranges.** It returns the current operator step in the reply to a range heartbeat; the range leader executes it. A step is done when a later heartbeat shows its effect, so a lost reply only repeats the step.
- **Soft state is rebuilt, not replicated.** Store and range statistics live in memory; after a leader change the schedulers wait two store-heartbeat intervals.
- **Node lifecycle** (PLAN 8.6): `joining` → `live` on the first heartbeat; `suspect` after 3 missed heartbeats; `dead` after `deadAfterMs`; `draining` and `decommissioned` only by an admin action, and a heartbeat does not undo them.
- **Cluster version** is the lowest binary version among live nodes and only rises (PLAN 19.5).
- Every scheduler run keeps its explanation (`explanations()`), including why it did nothing; operators carry theirs.

## Metrics emitted

| Metric | Type |
|---|---|
| `mindlog_pd_ranges_count` | gauge |
| `mindlog_pd_operators_count` | gauge |
