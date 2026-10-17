# ADR-0007: Leader leases and clock-offset assumptions

- Status: accepted
- Date: 2026-10-16
- PLAN: 7.1 (ReadIndex, lease reads, follower reads), 7.4 (timings), 9.3 (consistency levels)
- References: [raft-thesis.md](../references/raft-thesis.md), [etcd-raft.md](../references/etcd-raft.md), [hashicorp-raft.md](../references/hashicorp-raft.md)

## Context

A linearizable read needs proof that the node is still leader. ReadIndex gets it with a heartbeat round (one network round trip per batch of reads). A lease avoids that round trip if clocks run at roughly the same rate. Redis clients expect reads to be cheap, and PLAN 9.3 makes `lease` the default for Redis reads.

## Decision

- Leases are measured in **ticks of the leader's own clock**, never in wall-clock timestamps compared across nodes. Only clock *rate* matters, not offset.
- The leader stamps every heartbeat and append with its current tick (`Message.lease_tick`); responses echo it. The leader's lease runs until `t + leaseTicks`, where `t` is the latest tick that a quorum of voters (the leader counts itself at the current tick) has echoed. Using the send tick, not the receive tick, keeps the lease conservative.
- A follower that heard from a leader within the **minimum** election timeout ignores vote and pre-vote requests (unless the request is a leadership transfer). So no new leader can be elected while the old leader's lease may still hold, as long as `leaseTicks < electionTicks.min × (1 − maxDrift)`. Defaults: `leaseTicks = 9`, `electionTicks = [10, 20]`, tolerating 10% rate drift. Config validation rejects `leaseTicks >= electionTicks.min`.
- Lease reads require **CheckQuorum** (on by default) and an entry of the leader's term committed (the election no-op).
- Read levels (`ReadBarrier` port in `@mindlog/services`):
  - `linearizable`: ReadIndex with a heartbeat round. Used by `WATCH`/`EXEC` and admin reads.
  - `lease`: served at the commit index if the lease holds, otherwise falls back to ReadIndex. Default for Redis reads.
  - `bounded_staleness(δ)`: served locally if the HLC of the last applied command is within δ of the node's clock, otherwise ReadIndex.
- On a follower, `linearizable` and `lease` forward a ReadIndex request to the leader and wait until the local applied index reaches the returned index.
- `maxClockOffsetMs` (HLC, phase 0) is unrelated to leases; it bounds HLC skew for MVCC timestamps.

## Alternatives considered

- **Wall-clock leases** (hashicorp/raft `LeaderLeaseTimeout`): depends on clock offset, not only rate; a stepped clock breaks safety.
- **etcd `ReadOnlyLeaseBased`**: treats leadership with CheckQuorum as the lease, so a leader can keep serving for up to a full election timeout after losing quorum. Echoing the send tick bounds the lease precisely.
- **ReadIndex only**: correct with no clock assumption, but every read batch pays a round trip.

## Consequences

- A process paused for longer than the lease (GC pause, SIGSTOP) can resume and serve one stale lease read before its next tick notices the lease ran out. The tick counter only advances when ticks run, so a paused leader's lease does not expire in its own view. Mitigation: the replica refuses lease reads (falling back to ReadIndex) when more than two tick intervals of monotonic time have passed since its last tick.
- The simulator runs nodes with different clock rates within the drift bound and checks linearizability of lease reads.

## Amendment (2026-10-17, phase 4): HLC on every RPC and offset fencing

- One `HybridLogicalClock` per node, shared by the command stamper, the Raft transport, the PD client and the router's forward RPCs.
- The HLC travels on every node-to-node message, as an `hlc` field on `SendRequest`, `SnapshotRequest`, the PD requests and `Kv.Execute`. Receivers call `update()`.
- Apply merges `cmd.hlc` into the local clock, so followers' clocks never lag committed history.
- Each node also tracks the offset between a remote HLC's physical part and its own wall time. When `update()` rejects a remote timestamp, or the measured offset of a quorum of peers exceeds `cluster.maxClockOffsetMs`, the node **fences** itself for `2 × electionTimeout`:
  - lease reads fall back to ReadIndex;
  - it ignores its lease when deciding whether to serve;
  - it logs an error and sets `mindlog_clock_fenced_info` to 1.
- `mindlog_clock_offset_seconds` (a gauge, one series per peer) is exported.
- Correctness does not depend on the fence: leases use tick rates, not offsets. The fence protects the ADR-0027 snapshot-read bound, which assumes clock offsets stay within `maxClockOffsetMs`.
