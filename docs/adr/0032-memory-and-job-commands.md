# ADR-0032: Memory and job commands

- Status: accepted
- Date: 2026-10-18
- PLAN: 6.1 (command envelope), 6.2 (apply rules), 12.3, 12.7, 19.5 (cluster version)
- References: [mem0.md](../references/mem0.md), [cognee.md](../references/cognee.md)

## Context

PLAN 6.1 reserves bodies 20–25 for memory and 70–72 for jobs. Apply must be deterministic (CLAUDE.md rule 1) and must not run models (rule 2). Index updates happen in the same apply (PLAN 6.2). Phase 5 needs remember, forget, job leasing and completion.

## Decision

New `Command.body` cases (`proto/mindlog/v1/memory.proto`):
- `MemoryCommit = 20`: one user, a list of new memories (record, vector, BM25 terms with counts, entity mentions), entity edges, jobs to enqueue, and an optional job to complete in the same batch.
- `MemoryForget = 22`: one user, memory ids. Sets `expiredAt` (the record stays, PLAN rule 9), removes postings, vector and mentions, and adjusts stats. Hard delete is phase 8.
- `JobLease = 71`, `JobComplete = 72` (ADR-0017).
- `CommandResult.memory = 4`: `MemoryOutcome {ids, count}`.
- 21 and 23–25, 70 stay reserved.

Rules:
- Everything the apply writes is computed by the leader and carried in the command: ids (ULIDs), vectors, BM25 terms (so a tokenizer change in a later binary does not make replicas diverge), entity names and links. Apply only encodes keys, counts and resolves entity ids (`type:normName`).
- Apply checks the user's scope key is in the range span (`RANGE_MOVED`), and validation failures (unknown job, stale lease) are results, not exceptions.
- Forwarding: a memory request reaching a node without the user's leader replica travels as `ForwardRequest.memory {op, json}` and the reply is the JSON response. The JSON is the Zod-validated application request, so it is checked again on arrival.
- Memory and job commands are proposed only when the cluster version is ≥ 5 (`BINARY_VERSION = 5`); transaction commands need ≥ 4. Handlers are registered on every binary that knows them.

## Alternatives considered

- **Argv-style memory commands re-executed in apply** (like ADR-0021 for KV): apply would have to tokenize, link and resolve, coupling replica state to code versions; models can't run there anyway.
- **Full protobuf for the forwarded API requests**: duplicates every Zod schema in proto. JSON inside the proto envelope is enough for an internal hop between nodes of the same cluster version.

## Consequences

- Commands are larger (vector + terms per memory, about 2 KB for 384 dims).
- `buf breaking` must pass when un-reserving numbers; the reserved ranges shrink accordingly.
- A new apply-visible field needs a cluster-version bump.
