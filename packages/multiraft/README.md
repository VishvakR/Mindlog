# @mindlog/multiraft

Range replicas and the per-node store (PLAN 8.2, ADR-0028, layer `replication`). A `Replica` drives the pure core from `@mindlog/raft` with the log store, the state machine, a transport and timers. A `Store` hosts every replica of a node.

## Public API

| Export | Purpose |
|---|---|
| `Replica` | The core of a range replica. `propose(command)` implements `Proposer`. `read(level)` implements the services `ReadBarrier`. Also `changeMembership(cc)`, `transferLeader(to)`, `status()`, `isLeader()`, `leaderKnown()`, `start()` and `close()` |
| `Store` | All replicas of a node. `Store.start(deps)`, `addRange(id)`, `replica(id)`, `replicas()`, `close()`. It routes inbound messages by range, maps replica ids to node addresses, runs one tick timer, creates replicas for ranges first seen in a message, and keeps quiesced ranges live with per-node keepalives |
| `NodeTransport`, `NodeInboundHandler`, `ReplicaViews` | Node-level transport port (by address, one stream per peer node) and the per-range transport and scheduler a store hands each replica |
| `startSingleNode(deps)` | A started one-voter range that bootstraps and elects itself (`--single-node`, tests) |
| `RaftTransport`, `InboundHandler` | Per-range transport port (ADR-0025): `send`, `sendSnapshot`, `setPeers`, `attach`; the store's view, the simulator and Maelstrom implement it |
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
- A new range writes its initial state (members, descriptor) at index 5 (ADR-0028). Any replica that is not bootstrapped starts empty and is caught up by a snapshot.
- **Quiescence** (ADR-0028). An idle leader whose followers have everything sends quiesce heartbeats for an election timeout, then stops ticking. Followers stop when they get one. Any work or non-heartbeat message wakes the range, and the store wakes a follower whose leader's node goes quiet.
- One fsync per turn across ranges: give every range's `RaftLogStore` the same `GroupCommitStore` (from `@mindlog/storage`).
- Proposals on a follower are forwarded by Raft and resolved when this node applies them. A proposal not applied within `2 × electionTicks.max` ticks fails with `DEADLINE_EXCEEDED`, an indefinite result: the write may still apply.
- Reads follow ADR-0007:
  - `lease` uses the leader lease only if the last tick ran within two tick intervals;
  - `linearizable` uses ReadIndex, with reads batched per turn;
  - `bounded_staleness` uses the HLC of the last applied command.
- Fail-stop: any storage or apply error stops the replica; pending work gets `UNAVAILABLE`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_raft_term_count` | gauge | `range` |
| `mindlog_raft_role_info` | gauge (0 follower … 3 leader) | `range` |
| `mindlog_raft_commit_index_entries`, `mindlog_raft_applied_index_entries` | gauge | `range` |
| `mindlog_raft_elections_total` | counter | `range` |
| `mindlog_raft_commit_latency_seconds` | histogram | `range` |
| `mindlog_raft_proposals_dropped_total` | counter | `range`, `reason` (`busy`, `not_leader`, `deadline`) |
| `mindlog_raft_snapshots_total` | counter | `range`, `direction` (`sent`, `installed`) |
