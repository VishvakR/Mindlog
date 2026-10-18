# ADR-0031: Memory key layout and scope placement

- Status: accepted
- Date: 2026-10-18
- PLAN: 5.1 (key families; amended), 5.3–5.5, 8.5 (scope placement), 11.1–11.3, 12.7
- References: [mem0.md](../references/mem0.md), [redis-agent-memory.md](../references/redis-agent-memory.md)

## Context

PLAN 5.1 gives memory records, vectors, postings, edges, entities and jobs their own families (`m v t g e j`), and PLAN 8.5 wants a user's memory in one range so recall is single-range. Keys are `tenant · family · tuple`, so the families of one user are far apart in key order: `tenant·'m'·(user…)` and `tenant·'t'·(user…)` can land in different ranges, and a split could separate a user's records from their postings. The split-key chooser (`statemachine/src/range/split-key.ts`, ADR-0009) cuts only at `tenant · family · (first element)`.

## Decision

All memory data of a user scope lives under the **one family `m`**, with the user first and a sub-tag second:

| Key | Value |
|---|---|
| `m/(user, 'r', memoryId)` | `MemoryRecord` (MVCC) |
| `m/(user, 'v', memoryId)` | `MemoryVector` {modelId, float32 LE bytes} |
| `m/(user, 't', term, memoryId)` | BM25 posting {tf, docLen} |
| `m/(user, 'd', term)` | document frequency |
| `m/(user, 'b')` | BM25 stats {docs, totalLen} |
| `m/(user, 'e', type, normName)` | `MemoryEntity` {name, type, mentionCount} (the entity id is `type:normName`) |
| `m/(user, 'x', entityId, memoryId)` | entity mention (empty) |
| `m/(user, 'g', 'out'\|'in', src, relation, dst)` | `MemoryEdge` |
| `m/(user, 'j', jobId)` | `Job` (ADR-0017) |
| `m/(user, 's')` | index generation counter |

- `user` is `''` for tenant-wide memory. Agent and session are fields of the record and filters at query time (recall with `inherit` also matches the ancestors).
- `splitBoundary` already cuts at the first tuple element, so a user's records, indexes and jobs never split apart. No change to the split code.
- Families `v t g e j` stay reserved for non-memory uses (for example collections' vectors in phase 9).
- Entity ids are derived (`type:normName`), so two concurrent `remember` calls naming the same entity converge in apply without a lookup table.

## Alternatives considered

- **Keep separate families and teach the split chooser to keep them together**: a range would need to own several disjoint spans; ranges are contiguous by design (ADR-0009).
- **Scope before family** (`tenant · user · family …`): would change the key grammar for every family, including KV.
- **Random entity ids plus a name index**: needs a read-modify-write that races between concurrent proposals; the derived id makes apply decide.

## Consequences

- Recall, ingestion and job scans touch one range per user; the router locates a user by `keyPrefix(tenant, 'm', [user])`.
- A very large user can no longer be split by size until semantic split (PLAN 8.5, research); ADR-0009's per-range size limit is exceeded for such a user. Watch `mindlog_range_bytes`.
- Renaming an entity's type changes its id; aliases (phase 7) will add an alias key under `e`.
