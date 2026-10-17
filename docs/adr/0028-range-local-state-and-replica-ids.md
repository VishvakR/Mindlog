# ADR-0028: Range-local system state, replica ids and the multi-range store

- Status: accepted
- Date: 2026-10-17
- PLAN: 8.1, 8.2 (store, coalesced heartbeats, quiescence, batched Ready), 6.2 (idempotency)
- References: [tikv.md](../references/tikv.md), [cockroach-multiraft.md](../references/cockroach-multiraft.md)
- Amends: ADR-0005, ADR-0026 (keys), ADR-0025 (peer addressing)

## Context

A node now hosts many replicas in one pair of LevelDB instances (ADR-0005). Phase 3 had state that belonged to the whole store, and that state cannot be split, merged or shipped in a snapshot:
- the idempotency table;
- the expiry index;
- the dead-generation records;
- the GC cursor.

Raft ids were node ids, so a node that was removed from a range and later re-added would come back with the same id. It could then receive votes and messages meant for its earlier incarnation (TiKV and CockroachDB avoid this with per-replica ids).

## Decision

**Replica ids.** Each replica gets a `replicaId` from PD's id counter (ADR-0010). Ids are never reused, so a re-added node gets a new one. The Raft `from` and `to` fields are replica ids. For a range created in phase 3 style from `cluster.peers`, the replica id is the node's `node.raftId`, so bootstrap stays simple. The descriptor maps `replicaId → nodeId`, and the store maps `nodeId → address`. Addresses come from PD and from `cluster.peers`, not from `ConfState.addresses` any more.

**Range-local keys** (all `$node`, family `s`, first element after the tag is `rangeId`):

| Key | Purpose |
|---|---|
| `(range-desc, rangeId)` | applied `RangeDescriptor` |
| `(last-version, rangeId)` | ADR-0027 |
| `(range-stats, rangeId)` | approximate bytes, for ADR-0009 |
| `(idem, rangeId, requestId)`, `(idem-at, rangeId, version, requestId)` | idempotency (was store-wide) |
| `(expire, rangeId, atMs, tenant, key)` | expiry index (was `$system`) |
| `(deadgen, rangeId, version, tenant, key, gen)` | dead generations (was `$system`) |
| `(gc-cursor, rangeId)` | GC sweep position |
| `(frozen, rangeId)` | freeze marker (ADR-0009) |
| existing `applied`, `conf-state`, `raftlog`, `raft-state`, `raft-truncated` | unchanged, already per range |

**Snapshots** contain:
- the user keys in `[startKey, endKey)`;
- every `$node` key whose tuple starts with `(tag, rangeId)` for that range, apart from the log keys.

A snapshot install deletes exactly that set and writes the new one. Before installing, the store checks that the snapshot's descriptor overlaps no other **initialised** local replica. If it does, the snapshot is rejected and the sender retries later: a local split has not been applied yet. This is CockroachDB's rule.

**Store** (`@mindlog/multiraft` `Store`) per node:
- owns every replica, keyed by range id;
- is the transport's single `InboundHandler`, and routes by `Message.rangeId`;
- creates an **uninitialised** replica for a message to an unknown range at the local replica id. An uninitialised replica has an empty log and may vote, but holds no data until a snapshot or a local split initialises it;
- keeps tombstones `(tombstone, rangeId) → replicaId` for removed replicas, so stale messages do not bring them back;
- runs one tick timer for all ranges;
- handles each Ready cycle in four steps:
  1. collect `Ready` from every replica that has work;
  2. write all log changes in **one batch with one fsync**;
  3. send all messages, grouped by destination node;
  4. apply each range in order, then `advance`.

**Coalesced heartbeats.** All heartbeats and heartbeat responses to one node in a send cycle travel as one `HeartbeatBatch` field in `SendRequest`. Each entry is `{rangeId, from, to, term, commit, leaseTick, context}`. The receiver expands them back into Raft messages.

**Quiescence.** A leader with no pending proposals or reads, whose followers have `match = lastIndex` and an applied commit, sends `quiesce` in its heartbeats. When every follower has acked, or after an election timeout, both sides stop ticking that range for the rest of the term. Any proposal, any non-heartbeat message, or the transport reporting the leader's node unreachable wakes the range.

## Alternatives considered

- **Keep raft id = node id**: less code, but safety would depend on destroying state before every re-add.
- **One LevelDB per range**: simple isolation, but one fsync per range per cycle and thousands of open files.
- **TiKV's span check on every message**: needs the span in every Raft message; checking at snapshot install is enough.

## Consequences

- Store-wide jobs (expiry, GC) become per-range and run on each range's leader.
- The simulator's invariants are keyed by `(rangeId, index)`, and state hashes are taken per span.
- Metrics carry a `range` label. Per-range series are bounded by the number of ranges on a node.
