# ADR-0010: Placement driver as its own Raft group with a TSO

- Status: accepted
- Date: 2026-10-17
- PLAN: 8.3 (placement driver), 8.6 (node lifecycle), 9.2 (TSO), 19.5 (cluster versions), 21 (PD unavailable)
- References: [tikv-pd.md](../references/tikv-pd.md)

## Context

Ranges need an authoritative directory, monotonic ids, a timestamp oracle for transactions, and something that decides where replicas and leaders go. These are cluster-wide concerns, so they cannot live inside any one data range. The user chose to run PD from the same binary under a `--pd` role, not as a separate program.

## Decision

**Process.** `mindlog-server --pd` (or `pd.enabled: true`) opens a PD replica with its own data directory, `pd.dataDir`, which defaults to `<dataDir>/pd`. It has its own `RaftLogStore` and state LevelDB pair, and range id 0, which no data range uses. It serves the `mindlog.v1.Pd` Connect service on `pd.listen` (:7100). PD members are listed in `pd.peers` (id, address). A node can be PD-only, data-only (the `cluster.pdEndpoints` list is set), or both. `--single-node` runs both, with a one-voter PD and an in-process client.

**Replicated state** (the PD state machine, one apply handler per command):
- the range directory `pd/range/(rangeId)` → `RangeDescriptor`, plus an index `pd/range-end/(endKey)` → `rangeId` for key lookups;
- the id counter `pd/next-id` (one counter for nodes, ranges and replicas; ids are never reused);
- `pd/tso-max`, the TSO upper bound;
- `pd/node/(nodeId)` → `{address, zone, labels, state, binaryVersion}`;
- `pd/cluster-version`;
- an operator log of the last 1,000 operators with their explanations.

Directory updates are reported by range leaders after split, merge and membership applies, and are guarded by epoch: an update with an older epoch than the stored one is ignored.

**TSO** (from PD `tso.go`):
- On becoming leader, PD proposes `tso-max = max(now, saved + 1 ms) + 3 s` and serves nothing until that is applied.
- It hands out `(physicalMs << 16) | logical` from memory, in the same format as `Hlc`, so TSO timestamps and MVCC versions (ADR-0027) are comparable.
- Every 1 s, when `now + 1 s` reaches the bound, it proposes a new bound.
- A request for `count` timestamps returns the last one of the batch.
- Before handing out time, the leader waits until `physical > saved bound of the previous term`.

**Leader-only soft state** (not replicated; rebuilt from heartbeats after a PD failover):
- store heartbeats every 10 s: capacity, used bytes, range count, leader count, QPS, CPU, model health;
- range heartbeats from each range leader every 2 s, and at once after a change: descriptor, leader, size, QPS, per-follower match.

**Node lifecycle** (PLAN 8.6), replicated as node-state commands:
- `joining` until the first store heartbeat, then `live`.
- `suspect` after 3 missed heartbeats.
- `dead` after `pd.deadAfterMs` (5 min).
- `draining` and `decommissioned` are set by admin actions.

**Schedulers** (plugins: `name`, `intervalMs`, `schedule(cluster) → {operators[], plan}`) run on the PD leader:
- `repair`: replace replicas on dead nodes;
- `drain`: move replicas and leaders off draining nodes;
- `replica-balance`: by range count, then used bytes; difference above 1 range or 10%;
- `leader-balance`: by leader count;
- `hot-split` and `size-split`;
- `cold-merge`.

Placement rules filter candidate nodes:
- spread a range's replicas across `node.zone` values;
- `placement.tenantPins` (tenant → node labels) restricts a tenant's ranges.

Every scheduler run records a plan (the chosen operator or the reason nothing was chosen), shown on the dashboard.

**Operators.** An operator is a list of steps run by the range leader: `addLearner`, `promote`, `transferLeader`, `removeVoter`, `split`, `merge`.
- PD keeps at most one operator per range.
- A step is finished when a range heartbeat shows its effect, as in PD's `IsFinish`.
- PD sends the current step in its reply to a range heartbeat.
- An operator is cancelled if the range's epoch moves for another reason, or after 10 min.

**Cluster version** (PLAN 19.5): `cluster-version = min(binaryVersion of live nodes)`, raised only. Data nodes propose phase 4 command types (split, merge, freeze, txn) only when the cluster version is at least 4.

**PD down** (PLAN 21): the data path keeps routing with cached descriptors. Splits, merges, moves and TSO pause, so cross-range transactions return `UNAVAILABLE`.

## Alternatives considered

- **Meta range inside the data ranges** (CockroachDB): fewer processes, but PLAN 8.3 asks for a separate group, and TSO and scheduling fit poorly in a data range.
- **A separate `mindlog-pd` binary**: one more build and deploy artifact for the same code.
- **Replicating heartbeats**: every 10 s per node and 2 s per range through Raft is waste; the state is rebuilt within one interval.

## Consequences

- A PD failover loses at most one heartbeat interval of soft state; schedulers wait `2 × storeHeartbeat` after a PD leader change before scheduling.
- TSO costs one PD round trip per transaction start and commit; batching inside a node is possible later.
- The simulator runs PD as a Raft group on 3 of its nodes, with the same faults as data ranges.
