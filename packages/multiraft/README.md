# @mindlog/multiraft

Range replicas (PLAN 8.2, layer `replication`). In phase 3 each node hosts one range. A `Replica` drives the pure core from `@mindlog/raft` with the log store, the state machine, a transport and timers. Multi-range hosting, splits and merges come in phase 4.

## Public API

| Export | Purpose |
|---|---|
| `Replica` | The core of a range replica. `propose(command)` implements `Proposer`. `read(level)` implements the services `ReadBarrier`. Also `changeMembership(cc)`, `transferLeader(to)`, `status()`, `isLeader()`, `leaderKnown()`, `start()` and `close()` |
| `startSingleNode(deps)` | A started one-voter range that bootstraps and elects itself (`--single-node`, tests) |
| `RaftTransport`, `InboundHandler` | Transport port (ADR-0025): `send`, `sendSnapshot`, `setPeers`, `attach` |
| `Scheduler`, `SystemScheduler` | Timer port (`every`, `defer`), so the simulator drives time |
| `SINGLE_NODE_TRANSPORT`, `DEFAULT_REPLICA_OPTIONS`, `addressesOf` | Helpers |

## The Ready loop

Proposals, messages and ticks in one event-loop turn are collected, then each Ready is handled in order:

1. install a received snapshot (one atomic synced batch);
2. persist hard state and entries (one batch, fsync when `mustSync`; span `storage.write`);
3. send messages; snapshot messages stream a consistent state view;
4. apply committed entries in order (span `statemachine.apply`) and resolve proposals by request id;
5. `advance`, then compact the log if `snapshotEntries` applied entries have accumulated.

## Invariants

- Persist before send, apply in order (CLAUDE.md rule 3).
- **Boot reconciliation** (ADR-0026). The state store's applied `{index, term}` must lie on the log. If it is ahead (a crash between snapshot install and log rewrite), the log is reset to that point. If it is behind the compacted log, the replica refuses to start.
- A new range writes `bootstrapEntries(peers)`, so membership always comes from the log.
- Proposals on a follower are forwarded by Raft and resolved when this node applies them. A proposal not applied within `2 × electionTicks.max` ticks fails with `DEADLINE_EXCEEDED`, an indefinite result: the write may still apply.
- Reads follow ADR-0007:
  - `lease` uses the leader lease only if the last tick ran within two tick intervals;
  - `linearizable` uses ReadIndex, with reads batched per turn;
  - `bounded_staleness` uses the HLC of the last applied command.
- Fail-stop: any storage or apply error stops the replica; pending work gets `UNAVAILABLE`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_raft_term_count` | gauge | — |
| `mindlog_raft_role_info` | gauge (0 follower … 3 leader) | — |
| `mindlog_raft_commit_index_entries`, `mindlog_raft_applied_index_entries` | gauge | — |
| `mindlog_raft_elections_total` | counter | — |
| `mindlog_raft_commit_latency_seconds` | histogram | — |
| `mindlog_raft_proposals_dropped_total` | counter | `reason` (`busy`, `not_leader`, `deadline`) |
| `mindlog_raft_snapshots_total` | counter | `direction` (`sent`, `installed`) |
