# Phase 4 — Multi-Raft, placement driver, routing, transactions: exit-gate evidence

- Date: 2026-10-18
- PLAN: §24 Phase 4 (§8 ranges and routing, §9 transactions)
- Status: **not signed off**: the simulator gate was cut short and the Docker rebalance run did not finish (see "Not run")
- Decisions:
  - ADR-0007 amended: HLC carried on node RPCs, clock fencing.
  - ADR-0009: range size, split and merge policy.
  - ADR-0010 amended: PD is its own Raft group of range 0, with a batched TSO and persisted window.
  - ADR-0027: MVCC versions are per-range HLC timestamps (store format 3).
  - ADR-0028: range-local state, PD-allocated replica ids, tombstones.
  - ADR-0029: router, forwarding, `RANGE_MOVED` and `CROSS_RANGE`.
  - ADR-0030: Percolator transactions (amended with what was built).

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Simulator passes with splits, merges and faults | 1,000 seeds passed (3 and 5 nodes alternating, all range faults). A 10,000-seed run found one failing seed (5817, "state hashes differ"); it was a bug in the simulator's disk model, not the server (see below). It passes now, but the 10,000-seed run was **not repeated** | partial |
| Bank-transfer invariant holds for cross-range transactions | 300 and 240 seeds of `SIM_BANK=1` passed, and 200 of `SIM_PD=1 SIM_BANK=1`; the larger bank run was stopped before it finished | partial |
| Adding a node rebalances replicas within 10 min | Not run at the planned scale (see below). A 64 MB trial of `scripts/load-and-rebalance.sh 64` on the `cluster` profile balanced after 42 s: replicas per node went from `15 15 15 0` to `11 12 12 12` | partial |

`SIM_PD=1` passed 1,000 seeds earlier in the phase.

### Not run

- **Simulator at gate scale**: the 10,000-seed run, and 3,000 bank seeds, were not completed after the SimDisk fix. At the user's request the runs were stopped and cut back.
- **SimDisk bug (seed 5817)**: `SimDisk.write` with `sync` replaced the unsynced list after awaiting, so a batch written while a sync was in flight was dropped from it and lost on power loss while later batches survived. A replica then had a hole in its state, which showed up as differing state hashes. Fixed in `test/sim/sim-disk.ts`, with `test/sim/sim-disk.test.ts` failing before the fix. No server code changed.
- **The 1 GB rebalance run did not finish.** The plan asks for 5 GB in 10 minutes; the script is scaled down (default 128 MB with 8 MiB ranges, 16 ranges; 1024 gives over a hundred), because this machine and Docker Desktop cannot load 5 GB in a sensible time. Two attempts were cut short: the first by a session end, the second at the user's request to stop Docker testing. The first attempt showed `TRYAGAIN`, `TIMEOUT` and `no range holds that key` errors while ranges split under load; the router now retries placement failures and retries up to ten times (about three seconds), but that change has **not** been re-run against the cluster.
- **Maelstrom `lin-kv`, the chaos kill-leader run and the 3-node failover with the new Store**: failover (`FAILOVER_ITERATIONS=3` and `5`) passes; the Maelstrom and chaos Docker runs were skipped at the user's request. The Maelstrom binary is unchanged by this phase and has not been re-run.
- **No independent review**: the whole-branch review was done by the author, not a fresh reviewer.

## What the simulator checks now

`test/sim` runs the real `Store`, replicas, state machines and KV services.

New faults: splits, merges, leader transfers, membership changes (remove and re-add a member), one node with a skewed clock (it fences itself and its peers), and, with `SIM_PD=1`, the placement driver deciding splits, merges and placement on a cluster that starts with two empty nodes.

New workload, `SIM_BANK=1`: eight accounts in different ranges; transfers run as Percolator transactions while ranges split, merge and move, nodes crash and the network partitions.

Checks: one leader per range and term, one command per `(range, index)`, epochs never go back, spans tile the keyspace, state hashes per span are equal on every member, KV histories are linearizable, and for the bank: every snapshot sums to the same total, no balance is negative, no lock survives healing, no transaction is left in flight.

Bugs the simulator found while building this phase (all fixed, each with coverage): forwarded requests lost their range id; merged ranges recreated by stray messages; a lagging learner behind a quiesced leader; a lease read right after waking from quiescence; a re-proposed `Freeze` freezing a range again; merge nondeterminism; snapshot installs wiping split-off data; replicas recreated while being destroyed; stale replicas blocking a node's new replica; removed replicas lingering; transactions: locks read through a span reader that hides them, reads after a split answering "no such key", a partial commit on abort.

## Phase 4 checklist (PLAN 24)

| Task | Where |
|---|---|
| Range-scoped state; MVCC versions are HLC timestamps; store format 3 | `packages/statemachine` |
| `Store`: many replicas per node, one tick timer, one fsync per turn, quiescence | `packages/multiraft` |
| Split and merge; HLC on RPCs and clock fencing | `packages/multiraft`, `packages/statemachine`, `packages/core` |
| Placement driver: Raft group, TSO, directory, node lifecycle, schedulers with explanations, operators | `packages/pd`, `PdAgent` in `packages/multiraft`, `--pd` role in `packages/server` |
| Router: range cache, local or forwarded execution, retries, fan-out, scatter | `packages/router`, `packages/services/src/kv/routed-kv.ts`, `KvForwardService` in `packages/transport` |
| Transactions: Percolator behind `features.crossRangeTxn` | `packages/txn`, `test/sim/bank.ts` |
| Dashboard Cluster page | `web/src/pages/cluster-page.tsx`, `/api/cluster/*` ([screenshot](phase-4-cluster-page.png)) |
| `cluster` and `cluster-join` compose profiles; load-and-rebalance script | `docker-compose.yml`, `deploy/cluster/`, `scripts/load-and-rebalance.sh` |

## Deferred

- Semantic split (`features.semanticSplit`).
- Piscina for snapshot encoding (snapshots stay chunked async I/O).
- Joint consensus, MinIO, TLS on the internal port (phase 10).
- `CLUSTER.SPLIT` / `CLUSTER.MERGE` over RESP: splitting and draining are on the Cluster page and PD's admin RPC.
- Commit and rollback record GC for transactions; `WATCH` across ranges; gating transaction commands on cluster version ≥ 4.
