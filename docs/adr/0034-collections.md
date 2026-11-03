# ADR-0034: Collections: key layout, commands and cluster version 9

- Status: accepted
- Date: 2026-11-03
- PLAN: 5.1 (key families; amended), 6.1 (commands 50–52), 16.1–16.2, 16.7–16.8, 19.5
- References: [pocketbase.md](../references/pocketbase.md), [ADR-0031](0031-memory-key-layout-and-scope-placement.md), [ADR-0009](0009-range-size-split-and-merge-policy.md)

## Context

PLAN 5.1 gives collection records, secondary indexes and unique constraints the separate families `c`, `x` and `u`, and the schema `s/schema/(collection)`. Keys are `tenant · family · tuple` and ranges are contiguous, so a collection's records, its index rows and its unique claims could land in different ranges. A unique check would then need a cross-range transaction (PLAN 24 says "2PC across ranges"), and every record write would be a distributed write. The split chooser cuts only at `tenant · family · (first element)` (ADR-0031 uses this to keep a memory scope together).

## Decision

**Key layout.** Everything of one collection is under family `c`, with the collection name first:

| Key | Holds |
|---|---|
| `c/(coll,'s')` | `CollectionSchema` (versioned) |
| `c/(coll,'r',id)` | record (JSON bytes + version) |
| `c/(coll,'x',index,v1…vn,id)` | secondary index row (empty value) |
| `c/(coll,'u',index,v1…vn)` | unique claim, value = record id |
| `c/(coll,'j',…)` | the collection's durable jobs |

- A collection never splits apart, so a record write with its index rows and unique claims is one single-range command. **Unique indexes need no 2PC.**
- Effects across collections (relation cascade delete, view maintenance, orphan file cleanup) run as idempotent durable jobs in the collection that triggers them.
- There is no `index-secondary` package: index maintenance lives in `@mindlog/collections` apply.
- System collections (`_sessions`, `_otps`, `_externalAuths`, `_migrations`, `_cron`) use the same layout.

**Commands (cluster version 9, `BINARY_VERSION = 9`).**
- `RecordWrite = 50`: one or more creates, updates and deletes on one collection, applied atomically. Each op carries the full record (the leader resolves field modifiers, password hashes, autodates and embeddings before proposing), and updates and deletes carry `expect_version`. Apply validates against the stored schema, checks the version and the unique claims, and writes the record and its index rows. A failed check is the command's deterministic result (`CONFLICT`, `ALREADY_EXISTS`, `INVALID_ARGUMENT`), never a crash. It may also enqueue jobs.
- `SchemaChange = 51`: create, update or delete a collection schema with `expect_version`. Apply rewrites index rows when indexes change (collections up to 10,000 records; larger ones are refused, `shortcut:`).
- Body 52 (`FileMeta`) stays reserved: file names are record fields.
- `Command.actor = 6` records the acting agent of a delegated request beside `principal`.
- Every v9 binary applies the bodies; the services refuse to propose them below cluster version 9.

**Placement and routing.** A collection's commands go to its range's leader, using the same routed-leader mechanism as memory scopes (ADR-0016). Reads use the read barrier.

## Alternatives considered

- **PLAN's separate `c`, `x`, `u` families + Percolator for unique keys**: every write becomes a 2PC; the existing transaction layer is argv-based and would need typed writes.
- **Teach the split chooser to keep families together**: ranges are contiguous by design.

## Consequences

- A very large collection cannot be split by size (like a large memory scope, ADR-0031). Watch `mindlog_range_bytes`.
- Cascade deletes across collections are eventually consistent.
- One collection's write throughput is bounded by one Raft group.
