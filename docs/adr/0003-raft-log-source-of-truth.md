# ADR-0003: The Raft log is the single source of truth; apply is deterministic

- Status: accepted
- Date: 2026-10-11
- PLAN: 2 (principles 1, 4), 6 (command envelope, apply rules, change stream), 7.3, 7.5, 13 (log-native features)
- References: etcd-raft.md, graphiti.md, a-mem.md, letta.md, classic-level.md

## Context

Mindlog's distinctive features (branching memory, point-in-time recall, change streams, replica catch-up, backups, commit-time conflict decisions) all need a total order of every state change and replicas that never diverge.

The references show how divergence creeps in:
- etcd raft takes election timeouts from a global crypto RNG (`raft.go:104`).
- Graphiti sets `expired_at = utc_now()` inside invalidation logic (`edge_operations.py:724`).
- A-MEM mutates neighbour notes in place and mints ids with `uuid4()` and `datetime.now()`.

Each of these is harmless in a single process and fatal in a replicated state machine.

## Decision

1. Every state change, including expiry, GC, leases, job leasing and index generation switches, is a **command appended to a range's Raft log**. Data, indexes, graph, caches and collections are deterministic projections of committed commands.
2. `StateMachine.apply(cmd, index)` is **deterministic**:
   - no wall clock (use `cmd.hlc`);
   - no ambient randomness (seed from `index` or ids);
   - no network, no model calls;
   - all writes go into one `WriteBatch` committed with `appliedIndex`.
3. **Non-determinism happens before proposing, on the leader**: model inference, id generation (ULID from the `Clock`/`Random` ports) and HLC assignment. Their results travel inside the command.
4. **Idempotency**: every write carries `requestId`. Apply checks `s/idem/(requestId)` first.
5. **Fail-stop** on environmental apply errors (disk, corruption). Deterministic validation failures are recorded as the command's result.
6. **Append-only memory**: supersession sets `validTo`/`expiredAt` from the command's HLC and writes new versions. Nothing is overwritten in place.

Phase 0 lays the foundations: `Clock` and `Random` ports with fakes, a deterministic seeded PRNG, ULIDs from the ports, a `bigint` HLC, and a lint rule banning `Date.now`/`Math.random`/`new Date()` in `statemachine/**` and `*/apply/**`.

## Alternatives considered

- **State-based replication** (ship resulting rows or snapshots): loses the history that branching, `ASOF` and change streams need, and makes idempotency harder.
- **Re-run models on followers**: non-deterministic outputs (and HNSW insertion order) would diverge replicas. Embedding results in the command costs log bytes but guarantees convergence.
- **Local expiry or GC decisions per replica**: simpler, but replicas would disagree about what exists at a given index.

## Consequences

- Commands can be large (embeddings, extracted entities). Log size and snapshot frequency must be monitored (`mindlog_raft_log_size_bytes`), and proposal payloads are bounded.
- The simulator can replay any seed exactly, which makes Raft and apply bugs reproducible (CLAUDE.md §11).
- Every new command type needs a protobuf message (ADR-0004), an apply handler, an idempotency path and a simulator scenario.
- Revisit only if a feature cannot be expressed as a deterministic projection. That would be a design smell, not a reason to relax the rule.
