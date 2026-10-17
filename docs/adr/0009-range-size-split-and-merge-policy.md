# ADR-0009: Range size, split and merge policy

- Status: accepted
- Date: 2026-10-17
- PLAN: 8.1 (ranges), 8.2 (store), 8.5 (placement modes), 20 (scalability)
- References: [tikv.md](../references/tikv.md), [cockroach-multiraft.md](../references/cockroach-multiraft.md), [tikv-pd.md](../references/tikv-pd.md)

## Context

Phase 3 runs one Raft group over the whole keyspace. Phase 4 splits the keyspace into ranges, each with its own Raft group, so that data and load spread across nodes. Splits and merges must be replicated decisions (CLAUDE.md rule 8), must never cut a Redis key's header from its elements, and must keep an agent scope's memory in one range (PLAN 8.5).

## Decision

**Descriptor.** `RangeDescriptor {rangeId, startKey, endKey, epoch {confVersion, version}, replicas [{nodeId, replicaId, role}]}` (proto `mindlog.v1.RangeDescriptor`). A range covers the **encoded** keys `[startKey, endKey)`; empty `endKey` means +∞. The first range covers everything except the node-local `$node` tenant, which is never replicated. `confVersion` bumps on each membership change and `version` on each split or merge.

**Policy** (`ranges.*` config):
- Split when the approximate size exceeds `ranges.maxBytes` (64 MiB), or when QPS stays above `ranges.splitQps` (2,500) for `ranges.splitQpsWindowMs` (60 s).
- Merge with the right-hand neighbour when both are below `ranges.mergeBelowBytes` (16 MiB), both have QPS below a quarter of `splitQps`, and the result would stay below half of `maxBytes` (hysteresis, so a merged range does not split again at once).
- Size is tracked in apply: each handler's batch adds `key.length + value.length` per put and subtracts nothing (deletes and GC leave the counter). The counter is a replicated per-range stat, so it is deterministic. It is reset to the real span size by the next split, which scans the span to find its median key. `shortcut: the size never shrinks between splits, so merges may wait for the next scan; replace with a periodic replicated recount if merge latency matters.`

**Split keys.** The split key is the first key at or after the span's byte median, rounded down to a **Redis key boundary**: the encoded prefix `tenant · 'k' · (name)`, so a key's header and elements stay together. For the memory families `m v t g e q`, the boundary is the scope prefix `tenant · family · (user)` (PLAN 8.5). Other families split at the first tuple element.

**Split execution.** The range leader proposes `Split {splitKey, newRangeId, newReplicaIds}`, with ids allocated by PD (ADR-0028). Applying it (on every replica, in log order):
- The left descriptor ends at `splitKey`, and `epoch.version` is bumped on both halves.
- It writes the right range's descriptor, an applied state at index `RANGE_INIT_INDEX = 5` with term 5, the matching truncated log state, the version counter (ADR-0027), a copy of the idempotency records, and the right half's expiry and dead-generation entries.
- The store then starts the right replica. No user data moves.
- If a replica of the right range already exists locally and is initialised (it got a snapshot first), the apply skips the right-hand writes (TiKV `already_exist_regions`).

**Merge execution** (subsume, from CockroachDB):
1. The left leader checks that both ranges have the same replicas, then proposes `Freeze {mergeInto: leftId}` on the right range. Applying `Freeze` rejects every later command in the right range with `RANGE_MOVED`, and records the freeze index.
2. The left leader waits until every replica of the right range holds the freeze in its log (the right leader reports its followers' `match` ≥ freeze index through a `RangeStatus` forward RPC). Each of them will then apply it, because the right group keeps running while frozen.
3. The left leader proposes `Merge {right: descriptor, freezeIndex}` on the left range.
4. Applying `Merge` waits until the local right replica's applied index ≥ `freezeIndex`. This is the only apply that waits on another range. A replica that is missing or uninitialised blocks the left range; this cannot happen while membership is equal, because the right range committed the freeze on all members first.
5. The merge apply extends the left span, sets `epoch.version = max(both) + 1`, folds in the right range's idempotency records and expiry entries, sets version = max of the two (ADR-0027), and deletes the right range's `$node` state. The store then destroys the right replica.

A merge whose `Freeze` committed but whose `Merge` failed is retried by PD. A frozen right range with no merge in progress is unfrozen by `Unfreeze`, proposed by the right range's leader after `2 × electionTimeout` without a `Merge`, once it has checked with PD that no merge for that pair is in flight.

## Alternatives considered

- **Hash slots** (Redis Cluster's 16,384 slots): fixed, so no splits are needed, but scans lose key order and a scope cannot be kept together.
- **TiKV PrepareMerge / CommitMerge with log catch-up**: the source's log entries are shipped inside the merge command. It handles merges with diverged membership, but costs more code. We require equal membership, as CockroachDB does.
- **Exact size accounting with deletes**: needs the size of every overwritten value inside apply, which means an extra read per write.

## Consequences

- Every write path checks `key ∈ [start, end)` against the applied descriptor (ADR-0029).
- Simulator invariants: spans tile the keyspace (no gap or overlap among the latest descriptors), epochs only grow, and a frozen range applies no user command.
- Ranges stay small (≤ 64 MiB), which keeps the in-memory snapshot shortcut of ADR-0026 valid.
