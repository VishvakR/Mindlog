# @mindlog/raft

A pure Raft consensus state machine for one range (PLAN 7), modelled on etcd's `raft` package (see `docs/references/etcd-raft.md`). It has no network, disk, timers or global randomness, which makes it deterministic under the simulator.

## Public API

| Export | Purpose |
|---|---|
| `RawNode` | Drive with `tick()` and `step(message)`. Inputs: `propose`, `proposeConfChange`, `readIndex`, `leaseRead`, `transferLeader`, `reportUnreachable`, `reportSnapshot`. Drain with `hasReady()`, `ready()` and `advance(ready)`. Also `applyConfChange`, `compact`, `status`, `checkInvariants` |
| `Ready` | Work for the host: persist `hardState` / `entries` / `snapshot` (fsync when `mustSync`) → send `messages` → install `snapshot` and apply `committedEntries` → `advance` |
| `bootstrapEntries(peers)` | Committed ADD_VOTER entries at term 1 that every initial node of a new range writes, so membership always comes from the log |
| `validateConfChange`, `applyToConfState` | Single-server membership rules (ADR-0006) |
| `DEFAULT_RAFT_OPTIONS`, `validateRaftOptions` | PLAN 7.4 timings; rejects `leaseTicks >= electionTicks[0]` (ADR-0007) |

## Features

- Elections with PreVote, CheckQuorum, and vote rejection while a follower is in a leader's lease.
- Replication: AppendEntries with fast backtracking (conflict term/index hints), and Probe/Replicate/Snapshot progress states with inflight count and byte limits. The §5.4.2 commit rule plus a no-op entry on election.
- Reads:
  - ReadIndex, local or forwarded from followers, held until the first commit of the term;
  - leader leases counted in leader ticks echoed by followers (ADR-0007).
- Snapshots. The leader asks the host to stream one when a follower needs compacted entries, and the host fills in the actual metadata. A lost reply is retried after `2 × electionTicks.max`.
- Learners and single-server changes, applied on commit, one at a time.
- Leadership transfer with `TimeoutNow`. Proposals are forwarded from followers to the leader.

## Invariants

- All log indexes and terms are `bigint`.
- `applied ≤ committed ≤ lastIndex`; commit never decreases (`checkInvariants`).
- The host persists entries and hard state before sending the messages of the same Ready (PLAN 7.3).
- Randomness only comes from the injected `Random`. The nondeterminism lint rule covers `packages/raft/src`.
- `shortcut:` the uncompacted log is kept in memory (bounded by the snapshot threshold); multi-raft may need an async entry cache.

## Tests

- `test/election.test.ts`, `replication.test.ts`, `reads.test.ts` and `membership.test.ts` re-express etcd's paper tests and interaction scenarios as outcome assertions over an in-memory harness (`test/support/harness.ts`), using the same vocabulary: add nodes, campaign, propose, stabilize, tick, isolate, compact, transfer. Covered scenarios: single node, campaign, prevote, checkquorum, probe and replicate, replicate pause, lagging commit, slow follower after compaction, snapshot via append response, confchange add and remove, and Figure 8.
- `properties.test.ts`: fast-check properties of the quorum math and inflights.
- `chaos.test.ts`: random partitions, drops, reorders, restarts and compactions. Checks one leader per term and prefix-consistent applied logs. It runs 200 seeds by default; set `RAFT_SEEDS=10000` (or `RAFT_SEED=n` to replay one seed) for more.

## Metrics

None. The pure core emits no metrics; the host (`@mindlog/multiraft`) does.
