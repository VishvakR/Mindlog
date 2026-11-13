# Disk full

**Symptom.** Writes to some ranges fail with `UNAVAILABLE: the replica stopped after a failure`. The node logs `replica stopped after a storage or apply failure` (level fatal). `mindlog_raft_replica_failures_total{range}` increases.

**Confirm.** Run `df -h` on the data volume. The failed replica's range has new leaders on other nodes, and its `mindlog_raft_applied_index_entries` stops moving.

**Fix**
1. A replica that hit a storage error fail-stops for good; it never skips an entry (CLAUDE.md rule 6). The rest of the node keeps serving.
2. Free space: remove old logs and old local backups (`blobs/backups/*`, keep the newest), or grow the volume.
3. Restart the node. Its replicas reopen, replay from the applied index and catch up from the leader.
4. If space cannot be freed soon, move its replicas away: `POST /api/cluster/actions {"action":"drain-node","nodeId":"<id>"}`. PD does not move a single failed replica on its own (ADR-0041).

**Verify.**
- `mindlog_raft_replica_failures_total` stops rising after the restart.
- Applied indexes match the leaders'.
- Writes to the affected keys succeed.

**Record.** Free space before and after, what filled the disk, and whether a retention setting should change (`backup.keep`, MVCC retention, cold tier).
