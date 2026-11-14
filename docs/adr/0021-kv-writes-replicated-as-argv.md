# ADR-0021: KV writes are replicated as command argv

- Status: accepted
- Date: 2026-10-12
- PLAN: 6.1 (command envelope), 6.2 (apply rules), 9.1 (single-range transactions), 15.1
- References: valkey.md, resp3-spec.md

## Context

The Redis command surface has about 100 write commands in phase 1, each with options. Their effects must reach every replica identically (ADR-0003). Redis and Valkey solve the same problem for replicas and the AOF by **propagating the command itself**, after rewriting its non-deterministic forms (relative TTL → `PXAT`, `INCRBYFLOAT` → `SET`, `SPOP` → `SREM`; `t_string.c:184`, `:823`, `t_set.c:856`).

Mindlog commands already carry the proposer's HLC and receive a log index, which together remove the need for those rewrites.

## Decision

- A Redis write is proposed as `KvWrite { repeated bytes argv }`, the exact arguments the client sent (command name first).
- `apply()` re-executes the command through the same `@mindlog/kv` command registry, deterministically:
  - the current time is `hlcPhysical(cmd.hlc)`, so relative TTLs resolve the same on every replica;
  - randomness (`SPOP`, `SRANDMEMBER` with count) comes from `SeededRandom(index)`;
  - floating-point formatting uses one shared, deterministic formatter.
- `MULTI`/`EXEC` becomes `KvBatch { writes, watches }`. Watched keys carry the version seen at `WATCH` time, and apply returns a nil reply if any of them changed.
- The reply is a protocol-neutral `KvReply` protobuf, stored in the idempotency table under the command's `request_id` and rendered to RESP2 or RESP3 by the adapter.
- Read-only commands are never proposed. They execute on the node against applied state.
- Internal maintenance uses typed bodies, not argv: `Expire` (12) for keys found due by the expiry job, and `GcThreshold` (13) for MVCC and generation garbage collection.

## Alternatives considered

- **Typed protobuf ops per command** (`Set`, `Incr`, `HSet`, …): explicit and schema-checked, but about 60 messages to define, version and keep in sync with parsing, and it duplicates the command table.
- **Physical replication** (the leader computes resulting key/value writes): followers apply bytes blindly and stay simple, but the leader must read before it proposes (a race without locks), commands get larger for collection operations, and the log stops telling you which operation happened.

## Consequences

- Commands stay small and readable in the log, and audit and change streams can show the actual operation.
- Apply runs command parsing and semantics, so `@mindlog/kv` must stay free of ambient time and randomness. The determinism lint rule covers `**/apply/**`, and the kv write executors live under `packages/kv/src/apply/`.
- A command that cannot be applied deterministically cannot be added without a typed body and an ADR.
- Changing how an existing command parses arguments is a log-format change. It must be gated by cluster version (PLAN 19.5), because old entries are re-executed on replay.
