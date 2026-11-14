# ADR-0040: Embedded replicas and SDK sync

- Status: accepted
- Date: 2026-11-12
- PLAN: 13.10 (embedded replicas; amended), 15.5 (SDKs), 24 phase 10
- References: turso-embedded.md, [ADR-0039](0039-semantic-split.md)

## Context

PLAN 13.10 wants an SDK-side copy of some scopes that answers reads when the network is cut: bootstrap from a snapshot, follow the change stream, wait for its own writes before reading, and queue writes while offline with request ids. The change stream carries ids, not content, and resumes only from an in-memory tail per range (phase 7).

## Decision

- **Storage is SQLite** in both SDKs: Node's built-in `node:sqlite` and Python's `sqlite3`, with one schema (`memories`, `queue`, `cursors`), so neither SDK adds a dependency and either can open the other's file. PLAN named classic-level; SQLite gives the same with no native addon.
- **Follow, then read.** A replica opens the scope's SSE stream before it lists the scope, so nothing between the list and the stream is missed; changes, snapshots, flushes and its own writes run one at a time. Change events name ids; the replica fetches them with the new `getMany` operation. A `resync` (the server no longer holds the cursor) reads the scope again. The cursor is kept, so a restart resumes where it was.
- **Read-your-writes** comes from the write's answer, not from waiting on a log index: a remember returns the stored memories, and the replica stores them before returning. This needs no new field in write responses.
- **Offline writes** get a stable client `requestId`, which the server hashes with the tenant and principal into the command's idempotency key; replaying a queued write applies once. Queued memories are readable at once under a `local:<requestId>` id that the server's id replaces after the replay. Writes stay in order: while anything is queued, new writes queue behind it.
- **Local recall** is BM25 over the local texts, fused by RRF with vector similarity when the caller supplies an embedder; the client has no models.
- The Python SDK is the distribution `mindlog`, module `mindlog.sdk` (the `mindlog` namespace also holds `mindlog.v1`). LangGraph's store and checkpointer and CrewAI's storage are adapters on top of it.

## Alternatives considered

- **Log shipping** (libsql's frame replication): the replica would need the state machine and the range's whole log.
- **A write cursor (`rangeId:index`) in every answer**: a new field on every write path, and still a wait.

## Consequences

- A replica copies whole scopes: memory of a large scope costs local disk and a long first read.
- Local recall is not the server's recall (no entities, graph, rerank or packing).
- Requests ids are kept as long as the range's idempotency table keeps them; a write queued longer than that could apply twice.
- A replay into a split scope may land in another cluster than the original attempt if the layout changed meanwhile.
