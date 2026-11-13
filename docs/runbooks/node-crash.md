# Node crash and replacement

**Symptom.** A node stops answering: `/health` fails, `up{job="mindlog"} == 0` in Prometheus, and its ranges elect new leaders (`mindlog_raft_elections_total` rises on the others).

**Confirm.** On a surviving node, `redis-cli CLUSTER.INFO` shows the new leader and membership; the dashboard Cluster page (or `GET /api/cluster/overview`) marks the node down. Writes keep succeeding while a majority of each range is up (PLAN 21).

**Fix**
1. If the machine is healthy, restart the process with the same `node.raftId` and data directory. It replays its log from `appliedIndex + 1` and catches up (ADR-0005).
2. If the disk or data is lost, do not reuse the old data directory:
   1. Start a replacement with a new `node.raftId` and `cluster.join: true`.
   2. PD marks the old node dead after `pd.deadAfterMs` (default 5 min). Its repair scheduler then adds replicas on the remaining and new nodes.
   3. Then retire the old id for good: `POST /api/cluster/actions {"action":"remove-node","nodeId":"<id>"}`. This works only for a dead or draining node.
3. Keep a majority: in a 3-node cluster, never remove a second node before the first replacement has caught up.

**Verify.**
- `mindlog_raft_applied_index_entries` on the new or restarted node matches the leader's.
- `mindlog_store_replicas_count` is back to the expected number.
- The Cluster page shows no under-replicated ranges.

**Record.** Time of failure, cause, recovery duration, and whether any range lost quorum.
