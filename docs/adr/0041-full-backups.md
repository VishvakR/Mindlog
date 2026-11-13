# ADR-0041: Full backups from range snapshots

- Status: accepted
- Date: 2026-11-13
- PLAN: 10.5 (backups and restore; amended), 21 (disk full), 24 phase 11
- References: [ADR-0026](0026-raft-log-format-v2.md), [ADR-0028](0028-range-local-state-and-replica-ids.md), [ADR-0014](0014-encryption-at-rest.md)

## Context

PLAN 10.5 asks for full backups at a cluster-wide TSO timestamp, incremental log segments, point-in-time restore and a scheduled restore check. Nothing existed. A range snapshot (`StateMachine.snapshot`) already gives a consistent view of one range with its applied point, membership and descriptor, and a node already resets an empty log to installed state on boot (ADR-0026).

## Decision

- **Full backups only.** Each node writes the snapshot of every range it leads, the placement driver's range 0 included, to the default blob store: `backups/<id>/<rangeId>.snap` (size-delimited `SnapshotRequest`s, the snapshot stream's framing), then `backups/<id>/<rangeId>.json` (index, term, size, SHA-256). The manifest is written last, so its presence marks the range complete.
- **Ids without coordination.** Scheduled backups (`backup.intervalMs`, off by default) use the interval's start time (`20261113T120000Z`), so the nodes of a cluster fill one folder. A tick every ≤ 30 s fills ranges whose leader changed; ranges already present are skipped. `POST /api/admin/backups {id}` backs up on demand. `backup.keep` backups are kept.
- **Verify** (`mindlog-server backup verify <id>`, or `backup.verify` on range 0's leader after each backup) checks each snapshot against its manifest and restores the whole backup into in-memory stores: PLAN's "restore into a scratch cluster".
- **Restore** (`mindlog-server backup restore <id> --data-dir <new>`) refuses a backup whose data ranges do not tile the keyspace, installs every range with the node as its only voter (removed-replica records dropped), and clears the placement driver's node, range and operator records, keeping its id counter, TSO and cluster version. The node starts with `--single-node`; the range directory fills from heartbeats; more nodes join as usual.

## Alternatives considered

- **A TSO-timestamp cut with MVCC reads per range**: consistent across ranges, but needs a closed-timestamp wait on every range and a filtered export; not needed for the single-tenant-scope workloads ranges serve today.
- **Copying the LevelDB directories**: needs the node stopped or a filesystem snapshot, and carries other ranges' data and node-local state.

## Consequences

- Each range is consistent at its own applied index; there is no cluster-wide cut. Cross-range transactions (off by default) may restore half-done.
- No incremental log segments and no point-in-time restore (documented gap).
- A split or merge during a backup leaves a gap or overlap; verify and restore refuse that backup, and the next one is normally clean.
- With a local blob store, each node's ranges land on its own disk; whole-cluster backups need S3.
- Cold-tier segments and record files are referenced, not copied; deleting them later leaves dangling stubs in an old backup.
- Restore needs the backup's `storage.encryption.masterKey`; blobs are encrypted under it (ADR-0014), and `keys rotate-master` does not re-wrap them.
- Encoding and restore hold one range in memory (at most `ranges.maxBytes`).
- **Disk full** (PLAN 21): a storage error already fail-stops the replica; `mindlog_raft_replica_failures_total` now counts it. The placement driver does not re-replicate a single failed replica (it replaces dead nodes); the operator drains the node (runbook `disk-full.md`).
