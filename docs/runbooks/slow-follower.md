# Slow follower

**Symptom.** One node's `mindlog_raft_applied_index_entries` falls behind the leader's for its ranges. `mindlog_raft_snapshots_total{direction="sent"}` rises on the leader.

**Confirm.**
- Compare `CLUSTER.INFO` on the leader and on the follower.
- On the follower, check disk latency (`iostat`), CPU, and `mindlog_statemachine_apply_latency_seconds`.

**Fix**
1. A follower that falls behind the compacted log gets a snapshot automatically (PLAN 21). Let it finish.
2. If the disk or CPU is saturated, move load off the node: transfer leaders away (`transfer-leader`), or drain it.
3. If it never catches up, remove the replica and let PD add a fresh one elsewhere (`drain-node`).

**Verify.** The applied index matches the leader's, and snapshot sends stop.

**Record.** The cause, and how long the lag lasted.
