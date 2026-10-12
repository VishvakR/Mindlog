# ADR-0005: Separate LevelDB instance for the log; state store without fsync

- Status: accepted
- Date: 2026-10-12
- PLAN: 7.3 (persistence rules), 10.1 (engine), 10.3 (snapshots)
- References: [classic-level.md](../references/classic-level.md), [etcd-raft.md](../references/etcd-raft.md)

## Context

Every acknowledged write must survive kill -9 (PLAN 1.5, the phase 1 gate). An fsync per write costs a few milliseconds, and LevelDB compactions of a large state store contend with log appends for disk bandwidth. The log is the source of truth (ADR-0003): state can always be rebuilt by replaying committed entries above the last durable point. classic-level offers `sync: true` per batch and one exclusive lock per directory.

## Decision

- Each node opens **two LevelDB instances** under `node.dataDir`:
  - `raftlog/`: log entries `s/raftlog/(rangeId, index)` and hard state, written with **`sync: true`** and group-committed, so one fsync covers every append in an event-loop turn;
  - `state/`: MVCC data, indexes and `appliedIndex`, written **without fsync**.
- `appliedIndex` is written in the **same batch** as the effects of each apply. After a crash, recovery replays the log from `appliedIndex + 1`.
- The log is **never compacted past an index until the state store has been flushed with `sync: true` at or beyond it**. The snapshot and compaction routine does that flush first (CLAUDE.md rule 7).
- A write is acknowledged only after its log entry is fsynced and the command is applied.

In phase 1 a local single-node log takes Raft's place behind the `Proposer` port; the storage layout is the same.

## Alternatives considered

- **One instance, everything synced**: simplest, but every state write pays an fsync and compactions stall log appends.
- **One instance, only log keys synced**: LevelDB syncs the whole write-ahead log, so it cannot sync part of a batch.
- **A custom append-only log file**: fastest appends, but needs our own checksums, rotation and recovery code. Possible later behind the same port if profiling shows a need.

## Consequences

- Restart time grows with the amount of log above `appliedIndex`, which is bounded by snapshot and flush frequency (metric `mindlog_storage_replay_entries`).
- Two directories to back up and size. Backups use per-range snapshots, not raw directories.
- Losing the `state/` directory is recoverable from the log plus snapshots. Losing `raftlog/` on a single node loses unflushed acknowledged writes, which is why it is the synced one.
