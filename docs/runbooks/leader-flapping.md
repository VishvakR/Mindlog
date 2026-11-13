# Leader flapping

**Symptom.**
- `mindlog_raft_elections_total` rises steadily.
- `mindlog_raft_term_count` climbs.
- Clients see bursts of `NOT_LEADER` retries and latency spikes.

**Confirm.**
- Check `mindlog_clock_offset_seconds` and `mindlog_clock_fenced_info` (a fenced node has given up leases).
- Check `mindlog_transport_dropped_messages_total` and the event-loop lag metrics (`mindlog_nodejs_eventloop_lag_seconds` and its percentiles) on the leader.
- A leader that cannot heartbeat within `raft.electionTicks × raft.tickMs` loses leadership.

**Fix**
1. **Network:** look for packet loss or a partition between nodes, and fix the link.
2. **Overload:** a blocked event loop delays heartbeats. Shed load (per-tenant quotas, `limits.*`), or move hot ranges with `transfer-leader`.
3. **Clock:** a skew above `cluster.maxClockOffsetMs` (500 ms by default) fences leases. Fix NTP on the node.
4. While you investigate, pin leadership to a healthy node: `POST /api/cluster/actions {"action":"transfer-leader","rangeId":"<r>","replicaId":"<n>"}`.

**Verify.** The election rate drops to zero, and `NOT_LEADER` retries stop.

**Record.** The root cause, plus any timing changes (`raft.electionTicks`).
