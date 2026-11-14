# ADR-0009: Range size, split and merge policy

- Status: accepted
- Date: 2026-10-17
- PLAN: 8.1 (ranges), 8.2 (store), 8.5 (placement modes), 20 (scalability)
- References: tikv.md, cockroach-multiraft.md, tikv-pd.md

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

**Merge execution** (subsume, after CockroachDB). The merge runs on the **right range's leader**, and both ranges must have the same members:
1. Propose `Freeze {mergeInto: leftId}` on the right range, at index F. A frozen range applies nothing but its own unfreeze, and it leaves no trace in what a merge folds in: no version and no idempotency record, only the applied point. A refusal is kept under its own range-local tag (`refused`), so a re-proposed copy gets the same answer after an unfreeze; merges and splits never copy that tag, and a merge drops it with the right range. So every replica's frozen state folds in the same way, whenever it reaches the merge (amended 2026-10-29: refusals in the idempotency table made replicas diverge, simulator seeds 84 and 197).
2. Propose the same freeze again, at F2 > F, and wait until every member's `match` ≥ F2. Each member then knows F is committed: the append that carried F2 also carried a commit index ≥ F. Every member can therefore apply F from its own log, even after the right range has gone everywhere else. If a member falls short, the merge is abandoned and the range unfrozen.
3. Propose `Merge {right descriptor, freezeIndex: F}` on the left range, through the local left replica; Raft forwards it to the left leader.
4. Before applying `Merge`, each left replica waits until its local right replica has applied F, and then stops it. This is the only apply that waits on another range.
5. Apply checks that the stored right descriptor equals the one in the command, that the ranges are neighbours, that the right is frozen for this left range, and that the members are the same. A failed check is a deterministic `CONFLICT` result; the right replica restarts and the orchestrator unfreezes it.
6. The merge then:
   - extends the left span, with `epoch.version = max(both) + 1`;
   - folds in the right range's idempotency records, plus whatever the range hooks own (the KV expiry index and dead generations);
   - sets the version to the max of the two (ADR-0027) and adds the sizes;
   - deletes the right range's range-local state.
7. The state store is flushed (fsync) before the right range's Raft log is deleted. A power loss can then never leave a merge without its right half.

A second merge of the same pair finds the right range already gone and is refused the same way everywhere.

## Alternatives considered

- **Hash slots** (Redis Cluster's 16,384 slots): fixed, so no splits are needed, but scans lose key order and a scope cannot be kept together.
- **TiKV PrepareMerge / CommitMerge with log catch-up**: the source's log entries are shipped inside the merge command. It handles merges with diverged membership, but costs more code. We require equal membership, as CockroachDB does.
- **Exact size accounting with deletes**: needs the size of every overwritten value inside apply, which means an extra read per write.

## Consequences

- Every write path checks `key ∈ [start, end)` against the applied descriptor (ADR-0029).
- Simulator invariants: spans tile the keyspace (no gap or overlap among the latest descriptors), epochs only grow, and a frozen range applies no user command.
- Ranges stay small (≤ 64 MiB), which keeps the in-memory snapshot shortcut of ADR-0026 valid.
