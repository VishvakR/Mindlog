# Mindlog — Implementation Plan

> A Redis-compatible, Raft-replicated database that is also long-term memory for AI agents (over MCP) and, optionally, a full-stack app backend — with branchable memory, semantic conflict detection, point-in-time recall and a built-in admin dashboard. Runs fully offline.

| | |
|---|---|
| **Status** | Plan v1.0 — ready to build |
| **Date** | 2026-10-11 |
| **Server language** | TypeScript (Node.js LTS, strict mode) |
| **Model service language** | Python 3.12+ |
| **Total timeline** | 12 phases (0–11), about 36 weeks |
| **Minimum impressive cut** | Phases 0–5, plus branching, conflict detection and `ASOF` from phase 7, plus benchmarks (about 24 weeks) |

## How to use this file

- This is the **source of truth** for what to build and in what order. Save it as `docs/PLAN.md` in the repo and point Claude Code at it from `CLAUDE.md` (template in Appendix D).
- Build **one phase at a time**. Each phase lists tasks, deliverables, tests and an exit gate. Do not start a phase until the previous gate passes.
- Every significant decision gets an Architecture Decision Record (ADR) in `docs/adr/`. Section 25 lists the ADRs to write.
- Before each phase, read and analyse its reference projects (section 28) and record findings in `docs/references/`.
- `MUST` / `SHOULD` / `MAY` follow RFC 2119 meaning.

## Assumptions (change these if they are wrong)

1. Solo developer, about 25 hours a week, using Claude Code as a pair programmer.
2. Development on a laptop with 16 GB RAM; a cluster is simulated with 3–5 local processes or Docker containers.
3. No GPU required. All models are small and run on CPU.
4. "Enterprise-grade" here means the design, interfaces, testing and operations match what a production team would expect, even though the first deployment is a demo cluster.

---

## Table of contents

1. Vision, scope and success metrics
2. Architecture principles
3. System context and deployment topology
4. Module architecture (bounded contexts, ports and adapters)
5. Data model and key encoding
6. Replicated state machine and command catalog
7. Raft consensus specification
8. Multi-Raft, placement driver and cluster management
9. Transactions and consistency
10. Storage engine
11. Indexes
12. Memory engine (AI agent architecture)
13. Novel features — detailed specifications
14. Model service (Python)
15. External interfaces (RESP3, MCP, REST, gRPC, SSE, SDKs)
16. Full-stack backend mode
17. Admin dashboard
18. Security and multi-tenancy
19. Observability and operations
20. Scalability and performance engineering
21. Fault tolerance and degradation
22. Testing strategy
23. Engineering standards and CI/CD
24. Phased implementation plan
25. Architecture decision records to write
26. Risk register
27. Interview and resume framing
28. Reference open-source projects — study and analysis guide
- Appendix A — Glossary
- Appendix B — Configuration file reference
- Appendix C — Reference clone script
- Appendix D — `CLAUDE.md` template
- Appendix E — Definition of done

---

## 1. Vision, scope and success metrics

### 1.1 Problem

AI agents need durable, shared, trustworthy memory. Today a team stitches together Redis (cache and sessions), a vector database (semantic search), a graph database (relationships), a relational or document database (app data) and a memory library (Mem0, Cognee, Letta) on top. That stack is expensive to run, loses data on failover, cannot show what an agent believed at a past moment, and lets multiple agents silently overwrite each other's facts.

### 1.2 Solution

One system, built on one replicated log:

- **Redis-compatible key-value database** with Raft durability (no lost acknowledged writes).
- **Native agent memory**: extraction, hybrid retrieval (vector + BM25 + entity + Personalized PageRank), knowledge graph, consolidation — accessed over MCP.
- **Log-native agent features** that cannot be bolted onto Redis or a memory library: branchable memory, semantic conflict detection at commit time, point-in-time recall, provenance with quarantine, change streams.
- **Optional full-stack mode**: PocketBase-style collections, user auth, access rules, files and realtime.
- **Built-in admin dashboard** shipped with the server.
- **Fully offline**: every model runs locally on CPU.

### 1.3 Goals

| ID | Goal |
|---|---|
| G1 | Serve the core Redis command set over RESP3 so `redis-cli`, `redis-benchmark` and standard client libraries work unchanged. |
| G2 | Never lose an acknowledged write while a majority of replicas of its range is alive. |
| G3 | Give agents remember / recall / improve / forget over MCP with recall quality competitive with open-source Mem0 on LongMemEval. |
| G4 | Make shared memory safe for many agents: branches, conflict detection, point-in-time reads, provenance. |
| G5 | Scale horizontally by adding nodes: ranges split and rebalance automatically. |
| G6 | Run with no internet access. |
| G7 | Let humans inspect and edit all data and memory in a built-in dashboard. |
| G8 | Optionally serve as a complete app backend (collections, auth, rules, files, realtime). |

### 1.4 Non-goals (v1)

- Full Redis Cluster protocol, Lua scripting, Redis modules API, RDB/AOF file compatibility.
- SQL. (View collections use a small pipeline language instead.)
- Multi-region geo-replication.
- Training or fine-tuning models.
- Byzantine fault tolerance (nodes are trusted; network is not).

### 1.5 Service level objectives (targets to verify in phase 11)

Measured on a 3-node cluster on one laptop (local Docker network). Treat these as targets, not promises; publish what you actually measure.

| SLO | Target |
|---|---|
| Write availability | Writes succeed while ≥ 2 of 3 replicas of the range are up |
| Leader failover | New leader elected and serving writes in < 3 s after leader crash |
| KV write latency (p99, no model) | < 15 ms |
| KV read latency (p99, lease read) | < 3 ms |
| Recall latency (p95, 100K memories in scope, no rerank) | < 150 ms |
| Memory write latency (p95, including extraction on CPU) | < 2 s; acknowledged asynchronously in < 20 ms when `ASYNC` |
| Durability | Zero acknowledged-write loss in Maelstrom and chaos runs |
| Recall quality | LongMemEval and LoCoMo scores published with the exact configuration |

---

## 2. Architecture principles

1. **The log is the source of truth.** Every state change is a command in a Raft log. Key-value data, memory records, indexes, the knowledge graph, collections and caches are deterministic projections of committed commands. Branching, time travel, change streams, backups and replica catch-up all fall out of this.
2. **Hexagonal architecture (ports and adapters).** Domain modules depend only on interfaces ("ports") they own. Infrastructure (LevelDB, gRPC, the Python model service, the filesystem, the clock) is plugged in through adapters. Domain code never imports Fastify, LevelDB or `net`.
3. **Low coupling, high cohesion.** Each module owns one bounded context, exposes a small public API from its `index.ts`, and never reaches into another module's internals. Cross-module communication is either a direct call through a port or an event on the internal event bus. ESLint boundary rules enforce this (section 23).
4. **Determinism where it matters.** The state machine `apply` function is pure with respect to its inputs: same committed command sequence → same state on every replica. Anything non-deterministic (model inference, wall-clock time, randomness) happens **before** proposing, and its result is embedded in the command.
5. **Async, resumable, idempotent pipelines.** Expensive AI work runs as durable jobs stored in the database itself, processed by worker pools with backpressure, and safe to retry.
6. **Offline-first and degradable.** If the model service is down, the system keeps serving KV traffic and stores raw episodic memories; enrichment catches up later.
7. **Secure by default.** Auth on, TLS available everywhere, least-privilege scopes, untrusted content quarantined.
8. **Observable by default.** Every request carries a trace; every module exports metrics; every decision that affects data (conflict, quarantine, eviction) is auditable.
9. **Standard interfaces only.** RESP3, MCP, gRPC/protobuf, REST/JSON, SSE, OpenTelemetry, Prometheus. No bespoke wire protocol.
10. **Testability is a design requirement.** Network, disk, clock and randomness are injected, so the whole cluster can run inside a deterministic simulator.

---

## 3. System context and deployment topology

### 3.1 Actors

| Actor | Connects through | Typical use |
|---|---|---|
| Backend application | RESP3 (any Redis client) | Cache, sessions, queues, leaderboards, KV and JSON data |
| AI agent (Claude, Cursor, LangGraph, CrewAI, custom) | MCP (stdio or Streamable HTTP) | remember, recall, branch, resolve conflicts |
| Web or mobile app | REST + SSE (full-stack mode) | Collections, user login, files, realtime |
| Service | gRPC or SDK | Programmatic access, bulk import |
| Human operator / developer | Dashboard (browser) | Inspect data and memory, manage cluster, write rules |
| Prometheus / OTel collector | HTTP scrape / OTLP | Monitoring |

### 3.2 Processes

| Process | Language | Replicas | Role |
|---|---|---|---|
| `mindlog-server` | TypeScript | 3+ (one per node) | Protocol adapters, Raft, storage, indexes, memory engine, dashboard host |
| `mindlog-pd` | TypeScript | 3 (can be co-located with servers in small clusters) | Placement driver: range map, timestamp oracle, scheduling |
| `mindlog-models` | Python | 1 per server node (sidecar) | Embeddings, entity extraction, NLI, fact extraction, reranking |
| Object store (optional) | MinIO / S3 | external | Files (full-stack mode), cold memory tier, backups |

Single-node mode runs one `mindlog-server` with an embedded single-member PD and one model sidecar — the developer experience is `docker compose up` or one binary plus the Python service.

### 3.3 Ports

| Port | Protocol | Purpose |
|---|---|---|
| 6379 | RESP3 over TCP (TLS optional) | Redis clients |
| 8765 | MCP Streamable HTTP | Remote agents (stdio needs no port) |
| 8090 | HTTP | Dashboard (`/_/`), REST API (`/api/`), SSE (`/api/realtime`), `/metrics`, `/health`, `/ready` |
| 9090 | gRPC | Public gRPC API and SDKs |
| 7000 | gRPC (mTLS) | Internal node-to-node: Raft transport, snapshot streaming, forwarding |
| 7100 | gRPC (mTLS) | Placement driver |
| 50051 | gRPC (localhost only) | Server → model sidecar |

### 3.4 Topology diagram

```
                 ┌────────────────────────── Clients ──────────────────────────┐
                 │ Redis clients   AI agents (MCP)   Browsers/apps   Services  │
                 └──────┬───────────────┬─────────────────┬─────────────┬──────┘
                        │ RESP3         │ MCP             │ REST/SSE    │ gRPC
        ┌───────────────▼───────────────▼─────────────────▼─────────────▼───────────────┐
        │                         mindlog-server  (node N, ×3+)                          │
        │  ┌──────────────────────── Interface layer (adapters) ───────────────────────┐ │
        │  │ resp │ mcp │ rest+sse │ grpc │ dashboard static                           │ │
        │  └──────────────────────────────┬────────────────────────────────────────────┘ │
        │  ┌──────────────── Application layer ─────────────────────────────────────────┐ │
        │  │ auth/authz │ command router │ kv service │ memory service │ collections svc │ │
        │  └──────────────────────────────┬────────────────────────────────────────────┘ │
        │  ┌──────────── Domain engines ──┴────────────────────────────────────────────┐ │
        │  │ memory engine (pipeline, recall, consolidation) │ rules engine │ cache    │ │
        │  └──────────────────────────────┬────────────────────────────────────────────┘ │
        │  ┌──────────── Replication ─────┴────────────────────────────────────────────┐ │
        │  │ range replicas (Multi-Raft) │ state machine apply │ change stream         │ │
        │  └──────────────────────────────┬────────────────────────────────────────────┘ │
        │  ┌──────────── Storage & indexes┴────────────────────────────────────────────┐ │
        │  │ LevelDB (MVCC) │ HNSW │ BM25 │ graph │ secondary/unique │ blob store       │ │
        │  └───────────────────────────────────────────────────────────────────────────┘ │
        └──────────┬──────────────────────────────┬───────────────────────┬──────────────┘
                   │ gRPC :50051                  │ gRPC :7000 (mTLS)     │ gRPC :7100
          ┌────────▼────────┐            ┌────────▼────────┐     ┌────────▼────────┐
          │ mindlog-models  │            │  other nodes    │     │  mindlog-pd ×3  │
          │ (Python)        │            │  (Raft peers)   │     │ range map, TSO  │
          └─────────────────┘            └─────────────────┘     └─────────────────┘
```

---

## 4. Module architecture

### 4.1 Layering and dependency rule

Dependencies point **inward only**:

```
interfaces (adapters: resp, mcp, rest, grpc, dashboard)
        ↓
application (services: kv, memory, collections, admin; auth; router)
        ↓
domain (engines: memory, rules, cache, branching, conflicts; pure logic)
        ↓
replication (raft, multiraft, state machine, change stream)
        ↓
storage & indexes (ports) ← infrastructure adapters (leveldb, hnswlib, fs, s3, grpc clients)
        ↓
core (types, errors, ids, encoding, clock port, config, logging, metrics, tracing)
```

Rules:
- A module MAY import only from its own layer's public APIs or layers below it.
- Infrastructure adapters implement ports declared by domain or storage modules; they are wired together only in `packages/server/src/bootstrap/` (the composition root).
- No module imports another module's internal files — only `@mindlog/<module>` (the package entry).
- Circular dependencies fail CI (`madge --circular`).

### 4.2 Package and module map

The repo is a pnpm workspace. Each server module is an internal package with its own `package.json`, tests and README, so boundaries are enforced by the build, not just convention.

| Package | Layer | Responsibility (single purpose) | Key exports |
|---|---|---|---|
| `@mindlog/core` | core | Shared types, `Result<T,E>`, error codes, ULID/HLC ids, byte encoding helpers, `Clock` and `Random` ports, config loader, logger, metrics registry, tracer | `Result`, `MindlogError`, `Hlc`, `Clock`, `encodeKey`, `logger` |
| `@mindlog/proto` | core | Protobuf schemas and generated TS types for log commands, internal RPCs, public gRPC, model service | generated types |
| `@mindlog/storage` | storage | `KvStore` port + LevelDB adapter, MVCC read/write, write batches, snapshots, GC | `KvStore`, `MvccReader`, `WriteBatch`, `LevelDbStore` |
| `@mindlog/blob` | storage | `BlobStore` port + local-disk and S3 adapters | `BlobStore` |
| `@mindlog/index-vector` | storage | `VectorIndex` port + hnswlib-node adapter, persistence, deterministic insertion | `VectorIndex`, `HnswIndex` |
| `@mindlog/index-text` | storage | BM25 tokenizer, postings, scorer | `KeywordIndex`, `Bm25Index` |
| `@mindlog/index-graph` | storage | Adjacency lists, traversal, Personalized PageRank | `GraphIndex`, `ppr()` |
| `@mindlog/index-secondary` | storage | Secondary and unique index maintenance | `SecondaryIndex` |
| `@mindlog/raft` | replication | Pure Raft state machine (no I/O) + log storage port + transport port | `RaftNode`, `RaftLogStore`, `RaftTransport` |
| `@mindlog/transport` | replication | gRPC transport for Raft, snapshot streaming, request forwarding | `GrpcRaftTransport` |
| `@mindlog/multiraft` | replication | Range replicas, range lifecycle, coalesced heartbeats, split/merge execution, router cache | `Store`, `Replica`, `RangeRouter` |
| `@mindlog/statemachine` | replication | Command catalog, deterministic `apply`, idempotency table, change stream emitter | `StateMachine`, `Command`, `ChangeStream` |
| `@mindlog/pd` | replication | Placement driver: range map, TSO, store heartbeats, schedulers | `PlacementDriver`, `PdClient` |
| `@mindlog/txn` | domain | Single-range transactions, Percolator 2PC client, lock resolution | `TxnCoordinator` |
| `@mindlog/kv` | domain | Redis data-type semantics (strings, hashes, lists, sets, zsets, streams, JSON, TTL) as commands | `KvService`, command handlers |
| `@mindlog/models-client` | domain port + infra | `Embedder`, `Extractor`, `EntityRecognizer`, `NliClassifier`, `Reranker`, `Summarizer` ports + gRPC adapter to Python | model ports |
| `@mindlog/memory` | domain | Memory engine: ingestion pipeline, recall pipeline, ranking, packing, conflict detection, provenance | `MemoryService`, `RecallPipeline`, stages |
| `@mindlog/consolidation` | domain | Background workers: sleep-time consolidation, evolution, dedup, theme summaries, forgetting, tiering | `ConsolidationScheduler`, workers |
| `@mindlog/branching` | domain | Branch metadata, overlay reads, merge planner, CRDT field merge | `BranchService` |
| `@mindlog/jobs` | domain | Durable job queue stored in the KV store, leases, retries, dead-letter | `JobQueue`, `Worker` |
| `@mindlog/cache` | domain | Memory-aware semantic cache with dependency invalidation | `SemanticCache` |
| `@mindlog/collections` | domain | Collection schemas, record validation, view pipelines, hooks | `CollectionService` |
| `@mindlog/rules` | domain | Filter/rule language: lexer, parser, type checker, planner, evaluator | `parseRule`, `compile`, `evaluate` |
| `@mindlog/auth` | application | Identities, sessions, JWT, API keys, OAuth2, password hashing, RBAC, scope checks | `Authenticator`, `Authorizer` |
| `@mindlog/router` | application | Maps a request to a range/scope leader; forwards; retries on `NotLeader`/`RangeMoved` | `RequestRouter` |
| `@mindlog/eventbus` | core | In-process typed pub/sub for domain events | `EventBus` |
| `@mindlog/adapter-resp` | interfaces | RESP3 parser/serializer, connection handling, command table | `RespServer` |
| `@mindlog/adapter-mcp` | interfaces | MCP server: tools, resources, prompts; stdio + Streamable HTTP | `McpServer` |
| `@mindlog/adapter-http` | interfaces | Fastify REST, SSE realtime, admin API, health, metrics | `HttpServer` |
| `@mindlog/adapter-grpc` | interfaces | Public gRPC services | `GrpcServer` |
| `@mindlog/server` | composition root | Bootstraps config, wires adapters to ports, lifecycle, graceful shutdown | `main()` |
| `web` | interfaces | Dashboard (React + shadcn/ui, ADR-0023), built to static assets served by `adapter-http` | — |
| `sdk-ts`, `python/sdk` | clients | SDKs incl. embedded replica | — |
| `python/model_service` | infra | Model sidecar | — |

### 4.3 Ports (key interfaces)

These are the seams that keep modules decoupled. Adapters live in infrastructure packages; tests use in-memory fakes.

```ts
// @mindlog/core
export interface Clock { now(): bigint /* ms */; monotonic(): bigint /* ns */; }
export interface Random { next(): number; seed(s: bigint): void; }

// @mindlog/storage
export interface KvStore {
  get(key: Uint8Array, opts?: { at?: bigint /* version */ }): Promise<Uint8Array | undefined>;
  scan(range: KeyRange, opts?: { at?: bigint; limit?: number; reverse?: boolean }): AsyncIterable<[Uint8Array, Uint8Array]>;
  batch(): WriteBatch;
  snapshot(): Promise<StoreSnapshot>;        // consistent read-only view
  close(): Promise<void>;
}

// @mindlog/raft
export interface RaftLogStore {
  append(entries: LogEntry[]): Promise<void>;     // MUST fsync before resolving
  entries(lo: bigint, hi: bigint): Promise<LogEntry[]>;
  truncateSuffix(from: bigint): Promise<void>;
  compactPrefix(upTo: bigint): Promise<void>;
  hardState(): Promise<HardState>; saveHardState(h: HardState): Promise<void>;
}
export interface RaftTransport { send(to: NodeId, msg: RaftMessage): void; onMessage(h: (m: RaftMessage) => void): void; }

// @mindlog/models-client
export interface Embedder { embed(texts: string[], kind: 'query'|'passage'): Promise<Float32Array[]>; modelId(): string; dims(): number; }
export interface Extractor { extractFacts(input: ExtractInput): Promise<ExtractedFact[]>; }
export interface EntityRecognizer { recognize(texts: string[], labels: string[]): Promise<EntitySpan[][]>; }
export interface NliClassifier { classify(pairs: [string, string][]): Promise<NliResult[]>; } // entail|neutral|contradict + score
export interface Reranker { rerank(query: string, docs: string[]): Promise<number[]>; }
export interface Summarizer { summarize(texts: string[], instruction: string): Promise<string>; }

// @mindlog/index-vector
export interface VectorIndex {
  upsert(id: string, vec: Float32Array, meta: VecMeta): void;
  remove(id: string): void;
  search(q: Float32Array, k: number, filter?: (meta: VecMeta) => boolean): Array<{ id: string; score: number }>;
  persist(): Promise<void>; load(): Promise<void>;
}

// @mindlog/memory (stage contract — every pipeline stage implements this)
export interface PipelineStage<I, O> {
  readonly name: string;
  run(input: I, ctx: StageContext): Promise<Result<O, StageError>>;
}

// @mindlog/eventbus
export interface EventBus { publish<E extends DomainEvent>(e: E): void; subscribe<T extends DomainEvent['type']>(t: T, h: Handler<T>): Unsubscribe; }
```

### 4.4 Internal domain events

Events decouple producers from consumers inside a node. They are **not** a replication mechanism (replication is Raft). Events are emitted after a command is applied locally.

| Event | Emitted by | Consumed by |
|---|---|---|
| `CommandApplied { rangeId, index, cmd }` | statemachine | change stream, metrics, cache invalidation |
| `MemoryCommitted { scope, ids }` | statemachine | consolidation scheduler, cache invalidator, SSE |
| `ConflictRaised { conflictId, scope }` | statemachine | dashboard live feed, MCP notifications |
| `BranchMerged { scope, branch }` | statemachine | consolidation, audit |
| `RecordChanged { collection, id, op }` | statemachine | realtime (SSE), view maintainer, hooks |
| `LeaderChanged { rangeId, leader }` | multiraft | router cache, job workers (leader-only jobs) |
| `RangeSplit { parent, left, right }` | multiraft | router, index sharding |
| `ModelServiceHealth { up }` | models-client | memory pipeline (degraded mode), health endpoint |

### 4.5 Request lifecycle (example: `MEM.ADD` over RESP)

1. `adapter-resp` parses the frame, maps it to a typed `MemAddRequest`, attaches the connection's principal.
2. `auth.Authorizer` checks the principal may write the scope.
3. `router` resolves the scope to its range and leader; if this node is not the leader, it forwards over the internal transport.
4. On the leader, `memory.MemoryService.remember()` runs the ingestion pipeline (section 12) — or enqueues it as a durable job when `ASYNC`.
5. The pipeline produces a `MemoryCommit` command containing fully computed records, embeddings, entities, links and any conflicts.
6. `multiraft.Replica.propose()` appends it to the range's Raft log; it commits on majority.
7. Every replica's `statemachine.apply()` writes records and updates indexes deterministically.
8. The leader replies; `CommandApplied` and `MemoryCommitted` events fire; change-stream subscribers are notified.

---

## 5. Data model and key encoding

### 5.1 Key encoding

All data shares one ordered keyspace per node. Keys are byte strings built with an order-preserving tuple encoding that uses FoundationDB's tuple-layer typecodes (analysis: `docs/references/fdb-tuple.md`). Each element is type-tagged and self-delimiting. Strings and bytes escape `0x00` as `0x00 0xFF` and end with `0x00`. Integers use variable-length typecodes `0x0c`–`0x1c` (sign and byte length in the tag, big-endian payload, one's complement for negatives), so byte order equals numeric order. Doubles use the IEEE sign-flip transform.

```
key      := element(tenant) element(family) element(e1) … element(en) [ '@' version ]
element  := typecode payload             (self-delimiting; no separator bytes)
'@'      := 0x40, a typecode from the FDB user range, above every element code
version  := 8 bytes big-endian, bitwise-NOT of the commit index (newest version sorts first)
```

The `/` in prose such as `k/(key, 'h', field)` is notation for consecutive elements, not a stored byte. Because `0x40` is greater than every element typecode, all versions of one logical key are contiguous and sort before the keys of longer tuples that extend it.

| Family | Tuple | Holds |
|---|---|---|
| `k` | (range-local user key) | Redis values (encoded by data type, see 5.2) |
| `m` | (scope, branch, memoryId) | Memory records |
| `v` | (scope, segmentNo) | HNSW persisted segments |
| `t` | (scope, term, memoryId) | BM25 postings (value = term frequency + doc length) |
| `g` | ('out'\|'in', scope, src, relation, dst) | Graph edges |
| `e` | (scope, entityId) | Entity nodes (name, type, aliases, summary, embedding) |
| `c` | (collection, recordId) | Collection records (full-stack mode) |
| `x` | (indexName, value, primaryKey) | Secondary indexes |
| `u` | (collection, field, value) | Unique-constraint keys |
| `q` | (scope, promptHash) | Semantic cache entries |
| `j` | (queue, state, jobId) | Durable jobs |
| `s` | (subsystem, …) | System: schemas, branches, conflicts, idempotency table, range descriptors, users, API keys, audit log |

### 5.2 Redis value encoding

Every Redis key has a **header** at `k/(key)` (`KvHeader`: type, generation, element count, expiry, last-modified version, list head/tail). Collection elements live under the header's **generation** so that `DEL`, overwrite and expiry are one write; dead generations are removed later by replicated `GcThreshold` commands (ADR-0022).

| Type | Encoding |
|---|---|
| String | Value stored in the header |
| Hash | One key per field: `k/(key, gen, 'h', field)` |
| List | Header holds head and tail sequence numbers; one key per element `k/(key, gen, 'l', seq)` |
| Set | One key per member `k/(key, gen, 's', member)` |
| Sorted set | Two families: by member `k/(key, gen, 'z', member)` → score, and by score `k/(key, gen, 'Z', score, member)` |
| Stream | `k/(key, gen, 'x', msTime, seq)` per entry + consumer-group metadata keys |
| JSON | Value stored in the header (plain JSON in v1) |

TTL is enforced lazily on read and by a leader-only expiry job that finds due keys through the expiry index `s/expire/(atMs, tenant, key)` and proposes `Expire` commands (so expiry is replicated, never decided independently by replicas). Writes are replicated as the client's command argv and re-executed deterministically in apply (ADR-0021).

### 5.3 Memory record (canonical schema)

```ts
interface MemoryRecord {
  id: string;                 // ULID
  scope: ScopePath;           // { tenant, user?, agent?, session? }
  branch: string;             // 'main' or branch name
  kind: 'episodic' | 'semantic' | 'procedural' | 'working' | 'theme' | 'tool_trace';
  text: string;
  embedding: { modelId: string; dims: number; vector: Float32Array };
  entities: string[];         // entity ids
  links: Array<{ to: string; relation: 'related'|'supports'|'derived_from'|'supersedes'|'contradicts'; weight: number }>;
  source: { type: 'user'|'agent'|'tool'|'web'|'document'|'system'|'consolidation'; ref?: string; principal: string };
  trust: 'verified' | 'normal' | 'quarantined';
  importance: number;         // 0..1, set at write time, adjustable
  strength: number;           // forgetting-curve stability S (days)
  lastRecalledAt?: bigint;    // HLC
  recallCount: number;
  validFrom?: bigint; validTo?: bigint;   // world time: when the fact became / stopped being true (Graphiti valid_at / invalid_at)
  expiredAt?: bigint;                       // system time: when Mindlog learned it was superseded (Graphiti expired_at); never deleted
  createdAt: bigint;          // HLC of commit
  logIndex: bigint;           // commit index in its range
  version: number;            // increments on evolution (A-MEM)
  tier: 'hot' | 'cold';
  tags: string[];
  meta: Record<string, JsonValue>;
}
```

### 5.4 Entity and edge

```ts
interface Entity { id: string; scope: ScopePath; name: string; type: string; aliases: string[]; summary?: string; embedding?: Float32Array; mentionCount: number; }
interface Edge { src: string; relation: string; dst: string; weight: number; supportingMemories: string[]; validFrom?: bigint; validTo?: bigint; createdAt: bigint; expiredAt?: bigint; }
```

### 5.5 Scopes

`ScopePath = tenant / user / agent / session`. Each level is optional below `tenant`. Recall searches the requested scope and, when `INHERIT` is set, its ancestors (session → agent → user → tenant). Scope is the default **placement unit** for memory (section 8.5).

---

## 6. Replicated state machine and command catalog

### 6.1 Command envelope

```proto
message Command {
  bytes  request_id = 1;       // client-supplied or generated; used for idempotency
  string principal  = 2;       // who issued it (for audit and provenance)
  uint64 hlc        = 3;       // proposer's HLC timestamp
  string branch     = 4;       // default "main"
  oneof body {
    KvWrite kv_write = 10;  KvBatch kv_batch = 11;  Expire expire = 12;
    MemoryCommit memory_commit = 20; MemoryEvolve memory_evolve = 21; MemoryForget memory_forget = 22;
    MemoryRecallStats recall_stats = 23; ConflictResolve conflict_resolve = 24; Quarantine quarantine = 25;
    BranchCreate branch_create = 30; BranchMerge branch_merge = 31; BranchDrop branch_drop = 32;
    CacheSet cache_set = 40; CacheInvalidate cache_invalidate = 41;
    RecordWrite record_write = 50; SchemaChange schema_change = 51; FileMeta file_meta = 52;
    TxnPrewrite prewrite = 60; TxnCommit txn_commit = 61; TxnRollback txn_rollback = 62;
    JobEnqueue job_enqueue = 70; JobLease job_lease = 71; JobComplete job_complete = 72;
    SplitTrigger split = 80; MergeTrigger merge = 81; ConfChange conf_change = 82;
    // 13: GcThreshold gc_threshold (MVCC version and dead-generation GC, ADR-0022)
    AdminOp admin = 90;
  }
}
```

### 6.2 Apply rules

- `apply(cmd, index)` MUST be deterministic: no wall clock (use `cmd.hlc`), no randomness (seed from `index`), no network, no model calls.
- All writes of one command go into one `WriteBatch`, committed atomically together with the range's `appliedIndex`.
- **Idempotency:** before applying, look up `s/idem/(request_id)`. If present, skip and return the stored result. Entries expire after a retention window via a replicated GC command.
- Indexes (HNSW, BM25, graph, secondary) are updated in the same apply. HNSW insertion level randomness is seeded from `hash(memoryId)` so every replica builds an identical graph.
- After the batch commits, emit `CommandApplied` and the specific domain event.
- Results are stored as `CommandResult` (a `KvReply` for KV commands, or an `ErrorDetail`) under the idempotency key, so a retried request gets the original reply.
- Apply errors that are **deterministic** (validation failure) are recorded as the command's result; apply errors that are **environmental** (disk full) crash the replica (fail-stop) so it recovers from the log rather than diverging.

### 6.3 Change stream

Every applied command produces a change record `{ rangeId, index, hlc, principal, keys/ids touched, op }`. Subscribers (SSE, MCP notifications, SDK embedded replicas, view maintainers, cache invalidator) consume from a resumable cursor `(rangeId, index)`. The change stream is read from the Raft log plus a small in-memory tail buffer; after log compaction, a subscriber that fell behind receives a `ResyncRequired` signal and re-snapshots.

---

## 7. Raft consensus specification

The Raft implementation lives in `@mindlog/raft` as a **pure state machine with no I/O**: it consumes inputs (`tick`, `step(message)`, `propose(data)`, `readIndex(ctx)`) and emits a `Ready` struct (messages to send, entries to persist, entries to apply, snapshot to install, hard state to save). This is the same design as etcd's `raft` package. Pure design makes it fully testable in a deterministic simulator and keeps networking and disk in adapters.

### 7.1 Features (all required unless marked stretch)

| Feature | Purpose | Notes |
|---|---|---|
| Leader election | One leader per term | Randomized election timeout (seeded `Random` port) |
| PreVote | Prevents a partitioned node from disrupting the cluster when it rejoins with a higher term | Candidate first asks if it *could* win before incrementing term |
| CheckQuorum | Leader steps down if it cannot reach a majority within an election timeout | Required for safe leases |
| Log replication | AppendEntries with consistency check (prevLogIndex, prevLogTerm) | Fast backtracking using conflict term/index hints |
| Commit rule | Leader only commits entries from its own term by counting replicas | Raft paper §5.4.2 |
| Pipelining + batching | Several in-flight AppendEntries per follower; batch proposals per tick | Flow control: max in-flight messages and bytes per follower |
| ReadIndex | Linearizable reads without writing to the log | Leader confirms leadership with a heartbeat round |
| Leader lease reads | Serve reads without the heartbeat round during a lease | Lease < election timeout × (1 − max clock drift); requires CheckQuorum |
| Follower reads | Bounded-staleness reads from any replica | Follower asks leader for ReadIndex or serves at its applied index if staleness bound allows |
| Log compaction + snapshots | Bound log size | Snapshot = store checkpoint at applied index; InstallSnapshot streamed in chunks |
| Learners (non-voting) | Safe catch-up before promotion | Used by PD when adding or moving replicas |
| Membership changes | Add/remove voters | v1: one voter at a time (single-server changes); stretch: joint consensus |
| Leadership transfer | Drain a node, rebalance leaders | `TimeoutNow` message to a caught-up target |
| Proposal forwarding | Followers forward proposals to leader | Or reject with `NotLeader{leaderHint}` (router retries) |

### 7.2 Messages

`RequestVote`, `RequestVoteResponse`, `PreVote`, `PreVoteResponse`, `AppendEntries`, `AppendEntriesResponse`, `Heartbeat`, `HeartbeatResponse`, `InstallSnapshot` (chunked stream), `InstallSnapshotResponse`, `TimeoutNow`, `ReadIndex`, `ReadIndexResponse`. All defined in `@mindlog/proto` (`raft.proto`).

### 7.3 Persistence rules

- `currentTerm`, `votedFor` and log entries MUST be fsynced **before** sending any message that depends on them (vote grant, AppendEntries success).
- The Raft log is stored in LevelDB under `s/raftlog/(rangeId, index)` with hard state at `s/raft-state/(rangeId)` (format: ADR-0026). One LevelDB per node holds all ranges' logs (a separate instance from the state data so log fsyncs do not contend with compaction; ADR-005).
- Group-commit: many ranges' appends within one event-loop turn are written in one LevelDB batch with one fsync.
- Every entry stores a CRC32C checksum; a mismatch on read is treated as corruption (section 21).

### 7.4 Timing defaults (configurable)

| Parameter | Default |
|---|---|
| Tick interval | 100 ms |
| Heartbeat | every 1 tick |
| Election timeout | random in [10, 20] ticks (1–2 s) |
| Lease duration | 9 ticks (0.9 s) |
| Max in-flight AppendEntries per follower | 256 |
| Max entry batch size | 1 MiB |
| Snapshot threshold | 10,000 entries or 64 MiB of log since last snapshot |
| Snapshot chunk size | 1 MiB |

### 7.5 Invariants (asserted in tests and, in debug builds, at runtime)

1. Election safety: at most one leader per term.
2. Leader append-only: a leader never overwrites or deletes its own entries.
3. Log matching: same index and term ⇒ identical prefix.
4. Leader completeness: committed entries appear in all future leaders' logs.
5. State machine safety: no two replicas apply different commands at the same index.
6. Applied index never exceeds commit index; commit index never decreases.

### 7.6 Testing plan for Raft (detail in section 22)

- Unit tests of the pure state machine with scripted message sequences (port etcd's scenario tests as a checklist).
- Deterministic simulator: N nodes, simulated network (drop, delay, duplicate, reorder, partition), simulated disk (crash before/after fsync, torn writes), simulated clock — thousands of seeds per CI run, invariants checked after every step.
- Jepsen Maelstrom `lin-kv` workload with partitions: linearizability checked externally.
- Chaos on real processes: kill -9, network partitions via iptables/tc in Docker.

---

## 8. Multi-Raft, placement driver and cluster management

### 8.1 Ranges

A **range** is a contiguous slice of the keyspace with its own Raft group (default 3 replicas).

```ts
interface RangeDescriptor {
  rangeId: bigint;
  startKey: Uint8Array; endKey: Uint8Array;   // [start, end)
  epoch: { confVersion: number; version: number };  // bumps on membership change / split-merge
  replicas: Array<{ nodeId: string; replicaId: number; role: 'voter'|'learner' }>;
  placement: 'key' | 'scope' | 'semantic';
}
```

- Default max size 64 MiB; split at 64 MiB or on sustained load (QPS above threshold for 60 s).
- Merge adjacent small ranges (< 16 MiB each, low load) to bound range count.
- Requests carry the range epoch they targeted; a stale epoch returns `RangeMoved` with the new descriptor (router refreshes cache).

### 8.2 Store and replica management (`@mindlog/multiraft`)

- One `Store` per node manages all its `Replica`s.
- **Coalesced heartbeats**: heartbeats for all ranges between the same two nodes are batched into one message per tick (CockroachDB technique), so 10,000 ranges do not mean 10,000 heartbeats per tick.
- **Quiescence**: idle ranges stop ticking and heartbeating until a proposal arrives (saves CPU on large clusters).
- Ready-processing loop: each event-loop turn collects `Ready` from all active replicas, writes all log appends in one batch + fsync, sends all messages, then applies committed entries per range in order.
- CPU-heavy work (index updates for large batches, snapshot generation) runs on `worker_threads` with bounded queues.

### 8.3 Placement driver (`@mindlog/pd`)

Its own 3-replica Raft group (reusing `@mindlog/raft`), storing cluster metadata.

| Responsibility | Detail |
|---|---|
| Range directory | Authoritative map of key spans → range descriptors (clients cache it) |
| ID allocation | Monotonic ids for ranges, replicas, nodes |
| Timestamp oracle (TSO) | Hands out strictly increasing timestamps for transactions in batches (section 9) |
| Store heartbeats | Every node reports capacity, used bytes, range count, leader count, QPS, CPU, model-service health every 10 s |
| Schedulers | Balance replicas (by disk), balance leaders (by count/QPS), split hot ranges, merge cold ranges, repair under-replicated ranges, evacuate draining nodes |
| Placement rules | Spread replicas across failure domains (`zone` label); pin a tenant to nodes; keep a scope's memory together |
| Operator API | Admin commands: add/remove node, drain, transfer leader, split at key — exposed on the dashboard Cluster page |

Scheduling operators are **steps** (add learner → promote → transfer leader → remove old voter) executed by the range leader and confirmed back to PD; PD never mutates ranges directly.

### 8.4 Request routing (`@mindlog/router`)

1. Encode the request's key (or scope) → look up the range in the local cache.
2. Send to the cached leader; on `NotLeader{hint}` update and retry; on `RangeMoved` refresh from PD and retry.
3. Retries use exponential backoff with jitter and an overall deadline from the request context.
4. Multi-key commands (`MGET`, `DEL k1 k2`) are split by range and executed in parallel; results are merged in input order.

### 8.5 Placement modes

| Mode | Used for | Rule |
|---|---|---|
| Key range | Redis data, collections, secondary indexes | Ordered ranges split by size/load |
| Scope | Agent memory families (`m`, `v`, `t`, `g`, `e`, `q`) | Key prefix starts with `(tenant, user)` so a user's memory lives in one range; recall is single-range |
| Semantic split | A scope that outgrows one range | PD runs k-means (k = 2) over the scope's embeddings, assigns a `cluster` component inserted into the key after the scope, splits on it; recall routes to the clusters whose centroids are nearest the query (top-2 by default) |

Semantic split is the research piece. It needs: centroid storage in the range descriptor, re-clustering when drift exceeds a threshold (mean distance of new items to their centroid rises above 1.5× the value at split time), and background re-homing of items. Measure recall@10 against a single-range baseline and the bytes moved; this is a strong section for the write-up.

### 8.6 Node lifecycle

`joining` → `live` → (`draining` → `decommissioned`) | `suspect` → `dead`. A node is `suspect` after 3 missed store heartbeats and `dead` after 5 minutes; PD then re-replicates its ranges.

### 8.7 Hybrid logical clocks

Every node keeps an HLC (physical ms + logical counter). Every RPC carries the sender's HLC; receivers update theirs. Commands carry the proposer's HLC. HLC gives a cluster-wide, causally consistent notion of "time" used for `ASOF`, TTL, validity windows and audit. Max tolerated clock offset defaults to 500 ms; a node whose offset exceeds it fences itself (refuses leases) and alerts.

---

## 9. Transactions and consistency

### 9.1 Single-range transactions

`MULTI` … `EXEC`, Lua-free `WATCH`, and any multi-key write whose keys are all in one range are proposed as **one** command and applied atomically. `WATCH` is implemented by recording the watched keys' versions; `EXEC` includes them as preconditions checked in `apply`.

### 9.2 Cross-range transactions (Percolator-style 2PC)

Used for collections with unique constraints across ranges and for multi-scope memory merges.

1. Client gets `startTs` from PD TSO.
2. **Prewrite**: pick a primary key; for each key, write a lock `s/lock/(key)` and the data at `startTs` in its range (one command per range). Abort if a newer committed write or a foreign lock exists.
3. Get `commitTs` from TSO. **Commit primary**: replace the primary's lock with a commit record. This is the commit point.
4. **Commit secondaries** asynchronously; readers that hit a secondary lock check the primary's status and resolve it (roll forward or back).
5. Locks have a TTL; abandoned transactions are resolved by readers or a background lock-resolver job.

v1 scope: implement the protocol for collections' unique-index writes; keep the general API behind a feature flag until tested with the simulator.

### 9.3 Consistency levels

| Level | Guarantee | Mechanism | Default for |
|---|---|---|---|
| `linearizable` | Reads see all writes acknowledged before the read began | ReadIndex | Admin, `WATCH`/`EXEC` reads |
| `lease` | Same as linearizable assuming bounded clock drift | Leader lease | Redis reads, collection reads |
| `bounded_staleness(δ)` | Data at most δ old | Follower read at applied index if `now − appliedHlc ≤ δ` | Agent recall (δ = 500 ms) |
| `snapshot(t)` | Consistent view at time/index t | MVCC read at version | `ASOF`, exports, backups |
| `session` | Read-your-writes and monotonic reads for one client | Client carries last-seen index per range | SDKs and embedded replicas |

---

## 10. Storage engine

### 10.1 Engine

- `classic-level` (LevelDB) per node for state data, a second instance for Raft logs (ADR-005).
- All access goes through the `KvStore` port, so a different engine (RocksDB bindings, LMDB) can be swapped later.
- Writes only through `WriteBatch` created by `apply`; batches use `sync: true` only for the Raft log instance — the state instance can be written without fsync because it is rebuildable from the log above the last snapshot (the applied index is stored in the same batch, and on restart the node re-applies from `appliedIndex + 1`). Because of this, the Raft log MUST NOT be compacted past an index until the state instance has been flushed with `sync: true` at or beyond that index; the snapshot routine performs that flush first.

### 10.2 MVCC

- Version = a per-range HLC timestamp, `max(cmd.hlc, lastVersion + 1)` assigned in apply (inverted for newest-first ordering); ADR-0027 replaced the phase 1 "commit index" rule so versions survive splits and merges and compare with TSO timestamps. `ASOF` by time reads at that HLC directly.
- Read at version V: seek to `key@~V`, take the first entry with the same user key.
- Deletes write tombstones.
- **GC**: a leader-only job proposes `GcThreshold(index)` commands; apply removes versions older than the threshold except the newest one ≤ threshold. Threshold = now − retention window (default 7 days for KV, 30 days for memory; per-scope override). Branch fork points pin their versions until the branch is dropped.

### 10.3 Snapshots

- A Raft snapshot is a LevelDB snapshot (iterator pinned at a sequence) of the range's key span plus range metadata, streamed as `InstallSnapshot` chunks. The receiver writes to a staging area and atomically swaps (delete span + ingest).
- In-memory indexes (HNSW) for the range are rebuilt from persisted segments plus records after the snapshot index.

### 10.4 Tiered storage

- **Hot**: LevelDB + in-memory HNSW.
- **Cold**: memories with retention R below the cold threshold (section 13.7) move to the blob store (MinIO/S3 or local disk) as compressed segments; a stub record stays in LevelDB with the text summary and entity links so graph walks and explicit lookups still work. Recall can include cold tier with `INCLUDE_COLD` (slower).

### 10.5 Backups and restore

- **Full backup**: per-range consistent snapshot at a cluster-wide timestamp from TSO, written to the blob store with a manifest.
- **Incremental**: committed log segments since the last backup.
- **Point-in-time restore**: restore snapshot + replay log to the requested time.
- Backups are verified by a scheduled restore-into-scratch-cluster job (phase 11).

### 10.6 Encryption at rest (phase 10)

Per-tenant data keys (AES-256-GCM) wrapped by a master key from a file or environment KMS; values encrypted before writing, keys left in plaintext for ordering (document this trade-off in ADR-014).

---

## 11. Indexes

All index updates happen inside `apply`, so they are always consistent with committed data.

### 11.1 Vector index (HNSW)

- One HNSW graph per (scope, branch='main') in the `hnswlib-node` adapter; branches use an overlay: a small brute-force set of branch-local vectors searched together with main (branches are small).
- Parameters: M = 16, efConstruction = 200, efSearch = 64 (raise at query time for accuracy), cosine distance, 384 dims (MiniLM). Store `modelId` with every vector; a model change triggers a re-embedding job and a new index generation (section 14.5).
- **Determinism**: the hnswlib insertion level uses its own RNG; to keep replicas identical, either (a) seed per-insert from `hash(id)` via a small patch/fork of the binding, or (b) accept non-identical graphs (search results may differ slightly between replicas) and document it. v1 picks (b) with the record set itself identical everywhere; ADR-008 records the decision and the follow-up to (a).
- **Filtering during search**: pass a filter on (kind, trust, tier, validity) into the search when the binding supports a filter callback (Qdrant-style), so results are not post-filtered down to too few items. If it does not, over-fetch (k × 4, adaptive) and post-filter; verify which applies to the binding version you pin and record it in ADR-008.
- **Deletes**: mark deleted; rebuild the graph in a worker thread when deleted > 20%.
- **Persistence**: checkpoint the graph to `v/` segments every N inserts and on snapshot; on startup load the checkpoint and replay records after it.

### 11.2 Keyword index (BM25)

- Tokenizer: Unicode word segmentation (`Intl.Segmenter`), lowercase, stop-word list, light stemming (Porter for English; configurable per tenant).
- Postings `t/(scope, term, id)` → (tf, docLen). Per-scope stats: N (docs), avgdl, df(term) kept in `s/bm25stats/(scope)` and updated in apply.
- Score: BM25 with k1 = 1.2, b = 0.75:

```
score(q, d) = Σ_t∈q  IDF(t) · ( f(t,d) · (k1 + 1) ) / ( f(t,d) + k1 · (1 − b + b · |d| / avgdl) )
IDF(t)      = ln( (N − df(t) + 0.5) / (df(t) + 0.5) + 1 )
```

### 11.3 Graph index

- Edges stored in both directions (`g/out`, `g/in`) for fast walks.
- Entity resolution: exact normalized-name match first, then alias match, then embedding similarity ≥ 0.88 within the same entity type (threshold tuned on a labelled set).
- **Personalized PageRank** (adapted from HippoRAG's `graph_search_with_fact_entities` / `run_ppr`): the graph has **entity nodes and memory nodes** (a memory links to every entity it mentions) and is walked **undirected** with edge weights. Build the sub-graph within 2 hops of the seeds; run power iteration:

```
r_{k+1} = (1 − d) · s  +  d · Pᵀ r_k        d = 0.5 (HippoRAG default, configurable), ≤ 30 iterations or ‖Δr‖₁ < 1e-6
seed s (before normalising to sum 1):
  entity e  : mean query-fact score of facts mentioning e, divided by the number of memories that mention e (IDF-like); keep top 5 entities (linking_top_k)
  memory m  : min-max normalised dense-retrieval score of m × 0.05 (passage_node_weight)
```

  Memory scores = their own PPR values (memories are nodes, so no extra aggregation). If no positive seed exists, skip the retriever for that query. Runs in a worker thread with a node cap (default 5,000) to bound latency. Tune d, the entity top-k and the memory seed weight on the eval set (section 22.7).

### 11.4 Secondary and unique indexes

- `IDX.CREATE name ON key-pattern FIELD path TYPE string|number|tag` for hashes/JSON; collections declare indexes in their schema.
- Unique indexes `u/(collection, field, value)` are checked and written in the same command (single range) or via 2PC (section 9.2).

### 11.5 Index rebuild

Every index can be rebuilt from records with `ADMIN INDEX REBUILD <family> <scope>`, run as a durable job, used after corruption, model change or schema change.

---

## 12. Memory engine (AI agent architecture)

The memory engine is a set of small, single-purpose components connected by typed contracts. Each component can be replaced, disabled or tested alone. Nothing in the engine knows about RESP, MCP or HTTP; nothing knows which model runs behind a port.

### 12.1 Component map

```
                         ┌──────────────── MemoryService (facade) ────────────────┐
                         │ remember() recall() improve() forget() branch() ...    │
                         └───────┬───────────────────────┬──────────────────┬─────┘
                                 │                       │                  │
                  ┌──────────────▼───────┐   ┌───────────▼─────────┐  ┌─────▼──────────────┐
                  │ IngestionPipeline    │   │ RecallPipeline      │  │ Consolidation      │
                  │ (stages, see 12.3)   │   │ (stages, see 12.4)  │  │ Scheduler + workers│
                  └──────────────┬───────┘   └───────────┬─────────┘  └─────┬──────────────┘
                                 │ ports                 │ ports            │ ports
   ┌─────────────┬───────────────┼──────────┬────────────┼───────┬──────────┼───────────┐
   │ Embedder    │ Extractor     │ Entity   │ Nli        │ Rerank│ Summarizer│ JobQueue  │
   │ (models)    │ (models)      │ Recognizer│ Classifier│       │ (models)  │ (jobs)    │
   ├─────────────┴───────────────┴──────────┴────────────┴───────┴───────────┴───────────┤
   │ VectorIndex · KeywordIndex · GraphIndex · MemoryRepository (read) · Proposer (write)  │
   └──────────────────────────────────────────────────────────────────────────────────────┘
```

- **MemoryService** is a thin facade: validates input, checks scope permissions (via `Authorizer`), picks sync or async, returns results.
- **Pipelines** are ordered lists of `PipelineStage<I,O>` built by a `PipelineBuilder` from configuration, so stages can be toggled per tenant (`extraction: off`, `ppr: on`).
- **Proposer** is the only way the engine writes: it turns stage output into a `Command` and hands it to the range replica. The engine never writes storage directly.
- **MemoryRepository** is a read-only port over records, entities and edges at a given version/branch.

### 12.2 Stage contract and orchestration

```ts
interface StageContext {
  scope: ScopePath; branch: string; principal: Principal;
  deadline: number;               // absolute ms; stages must respect it
  trace: Span;                    // OpenTelemetry span
  config: ResolvedMemoryConfig;   // per-tenant config snapshot
  degraded: Set<'models'|'graph'|'rerank'>;  // capabilities currently unavailable
}
```

- Each stage returns `Result<O, StageError>`. Errors are classified `retryable` (model timeout), `skippable` (stage optional, e.g., rerank) or `fatal` (validation).
- The orchestrator applies per-stage timeouts, records a span and metrics per stage, and on `skippable` failure continues with the stage's declared fallback output.
- **Durable async mode**: `remember(..., { async: true })` writes the raw input as an episodic memory immediately (one command, fast ack) and enqueues an `enrich` job carrying the memory id. Workers run the full pipeline later and propose a `MemoryEvolve` that adds facts, entities and links. The agent always gets a fast response; enrichment is eventually consistent and visible through the change stream.

### 12.3 Ingestion pipeline (`remember`)

| # | Stage | Input → Output | Details |
|---|---|---|---|
| 1 | `Normalize` | raw message(s) → normalized text + metadata | Trim, language detect, strip control chars, cap size (default 32 KB per item) |
| 2 | `Redact` (optional) | text → text | Local PII detection (emails, phone numbers, ID-like patterns) masked per tenant policy |
| 3 | `Chunk` | text → passages | Sentence-aware, ~300 tokens, 15% overlap; documents only |
| 4 | `ExtractFacts` | passages → candidate facts | Local LLM via `Extractor` port with a strict JSON schema output; add-only (Mem0 2026 style): never emits update/delete; agent-confirmed actions are first-class facts |
| 5 | `RecognizeEntities` | facts → entity spans | GLiNER with tenant label set (person, organization, place, product, project, preference, date, …) |
| 6 | `LinkEntities` | spans → entity ids (+ new entities) | Resolution rules in 11.3 |
| 7 | `Embed` | facts → vectors | Batched; query/passage prefixes per model |
| 8 | `ScoreImportance` | facts → importance 0..1 | Heuristic v1 (explicit user statements, preferences, decisions score high; chit-chat low) + optional LLM rating 1–10 normalised |
| 9 | `LinkNotes` (A-MEM) | facts → links | Top-k (5) nearest existing memories with similarity ≥ 0.75 become `related` links |
| 10 | `DetectConflicts` | facts → conflicts | Section 13.2 |
| 11 | `ClassifyTrust` | facts → trust level | Source-based policy (section 13.4) |
| 12 | `AssembleCommit` | all → `MemoryCommit` command | One command per `remember` call, containing records, embeddings, entities, edges, links, conflicts |
| 13 | `Propose` | command → commit result | Through `Proposer`; idempotent on request id |

If the model service is unavailable, stages 4–9 are skipped, the raw passage is stored as `episodic` with an `enrich` job queued, and the response carries `degraded: true`.

### 12.4 Recall pipeline

| # | Stage | Details |
|---|---|---|
| 1 | `ParseQuery` | Extract query entities (GLiNER), detect time expressions ("last week" → validity filter), detect question level (specific vs broad) |
| 2 | `CheckCache` | Semantic cache lookup (13.9); on hit with valid dependencies, return immediately |
| 3 | `Retrieve` (parallel) | Retrievers run concurrently, each returns ranked ids with scores: **vector** (HNSW, k = 50), **keyword** (BM25, k = 50), **entity** (memories mentioning query entities), **ppr** (Personalized PageRank, 11.3), **theme** (theme memories for broad questions, LightRAG-style) |
| 4 | `Fuse` | Reciprocal Rank Fusion: `rrf(d) = Σ_r w_r / (k + rank_r(d))`, k = 60, per-retriever weights w_r (default 1.0; theme 1.5 for broad queries, ppr 1.2 for multi-hop) |
| 5 | `Filter` | Scope/branch/trust/tier, `ASOF`, validity window, `kind` filter |
| 6 | `Rerank` (optional) | Local cross-encoder on top 50 |
| 7 | `Score` | Final score (12.5) |
| 8 | `Diversify` | Maximal Marginal Relevance (λ = 0.7) to avoid near-duplicates |
| 9 | `Pack` | Token-budget packing (13.6) |
| 10 | `RecordRecall` | Asynchronously propose `MemoryRecallStats` (batched every 2 s) to raise strength S of recalled memories (forgetting curve) |
| 11 | `Explain` (optional) | Returns per-signal scores for the dashboard Recall Playground and for debugging agents |

### 12.5 Final scoring

```
score(d) = w_rel · norm(fused_or_rerank(d))
         + w_rec · recency(d)          recency(d) = 0.995 ^ hours_since(lastAccess(d))   (Generative Agents)
         + w_imp · importance(d)
         + w_ret · retention(d)        retention(d) = e^(−t/S)                          (MemoryBank)
         − penalty(trust(d))           quarantined: excluded unless requested; normal: 0; verified: −0.05 bonus
defaults: w_rel = 0.6, w_rec = 0.15, w_imp = 0.15, w_ret = 0.10
```

All weights are per-tenant configuration and tuned against the eval sets (section 22.7).

### 12.6 Consolidation workers (`@mindlog/consolidation`)

Leader-only background workers, scheduled per scope, all writing through the normal command path.

| Worker | Trigger | Work | Output |
|---|---|---|---|
| `SleepTimeConsolidator` (Letta-inspired) | Scope idle ≥ 10 min after ≥ 20 new memories, or every 24 h | Creates branch `sleep/<ts>`, distils sessions into semantic facts, writes "learned context" summaries, proposes merges of duplicates | Branch merged via the normal merge path (conflict check applies); rejected automatically if it raises > N conflicts |
| `EvolutionWorker` (A-MEM) | New memory linked to existing ones | Asks the Summarizer to refine tags/context of linked older memories | `MemoryEvolve` (new version; old kept) |
| `Deduplicator` | Nightly | Clusters near-duplicates (similarity ≥ 0.93) | Marks duplicates `supersedes` and lowers their weight; never deletes |
| `ThemeBuilder` (LightRAG/GraphRAG-style) | Graph changed by > 5% | Community detection (Louvain/Leiden on entity graph) → theme summary per community | `theme` memories linked to members |
| `ForgettingWorker` (MemoryBank) | Hourly | Computes retention; moves memories below cold threshold to cold tier | `TierChange` commands |
| `EntitySummarizer` | Entity mention count crosses thresholds | Refreshes entity summaries | `EntityUpdate` |
| `ReembedWorker` | Embedding model changed | Re-embeds a scope in batches | New index generation |
| `CacheJanitor` | Every 5 min | Drops expired cache entries | `CacheInvalidate` |

Worker rules: bounded concurrency per node, per-tenant budget of model-seconds per hour, every job idempotent (keyed by `(worker, scope, inputVersion)`), progress checkpointed so a leader change resumes rather than restarts.

### 12.7 Durable job queue (`@mindlog/jobs`)

- Jobs live in the `j` family of the scope's range, so they move with the data.
- States: `queued → leased → done | failed → dead`. Leasing is a replicated command with a lease expiry (HLC); the lease holder must be the range leader; on leader change, leases expire and the new leader re-leases.
- Retries with exponential backoff (max 5); then dead-letter, visible on the dashboard.
- Backpressure: if queue depth for a tenant exceeds a limit, `remember(async)` returns `BUSY` with a retry hint.

---

## 13. Novel features — detailed specifications

### 13.1 Branching memory

**Prior art and what is different.** Letta Code keeps each agent's memory as files in a git repository ("MemFS"), runs reflection ("dream") work in isolated git worktrees, and has a repair worker for git merge conflicts (`src/agent/memory-worktree.ts`, `memory-conflict-repair.ts`). Neon and Dolt branch whole databases. Mindlog branches **records inside a replicated database**: branches are created and merged through Raft so all replicas agree, merges are checked for **semantic** contradictions (NLI) rather than textual conflicts, structured fields merge as CRDTs, and many agents can branch the same scope concurrently.

**Model.** A branch is metadata `s/branch/(scope, name)` = `{ forkIndex, forkHlc, createdBy, status: 'open'|'merged'|'dropped', parent: 'main' }`.

**Writes on a branch** go to keys with `branch = name`. **Reads on a branch** use an overlay iterator: branch keys first, then `main` at version ≤ `forkIndex` for keys the branch has not touched. Deletions on a branch write branch tombstones.

**Indexes for branches**: small branch-local brute-force vector set + branch-local BM25 postings; searched together with main-at-forkIndex and merged by RRF.

**Merge algorithm** (`BranchMerge` command, computed on the leader, applied deterministically):
1. Collect branch changes (adds, evolves, forgets) in log order.
2. For each change, find main's changes to the same memory or the same entity since `forkIndex`.
3. Structured fields (tags, importance, counters, entity lists, link sets) merge with CRDT rules via Automerge-compatible semantics: sets = add-wins OR-set, counters = PN-counter, registers = last-writer-wins by HLC.
4. Text facts go through semantic conflict detection (13.2) against main's current facts.
5. Produce a merge result: applied changes, conflicts raised, rejected changes. If `policy = 'abort_on_conflict'` and conflicts > 0, nothing is applied.
6. Mark branch `merged`; release its pinned versions for GC.

**Commands**: `MEM.BRANCH`, `MEM.MERGE [POLICY abort|raise|prefer_branch|prefer_main]`, `MEM.DROP`, `MEM.DIFF scope branch`.

### 13.2 Semantic conflict detection

**When**: during ingestion (stage 10) and branch merge.

**Prior art and what is different.** Cognee ships an opt-in `detect_contradictions` task (off by default) that runs *after* data is stored, asks an LLM which facts contradict, and adds a `contradicts` edge without changing anything else. Graphiti invalidates contradicted edges using their valid/invalid dates. Mindlog's version differs in four ways: it runs **before commit** on the range leader, its outcome (conflict record + quarantine) is **part of the replicated command** so every replica and every agent sees the same decision, it uses a small **local NLI model** (no LLM call, offline), and it has an explicit **policy + resolution workflow** that also applies to **branch merges**. Also apply Graphiti's temporal rule: when both facts carry valid times and do not overlap, it is a change over time (set `validTo` / `expiredAt` on the older fact), not a conflict.

**Algorithm**:
1. For each new fact, retrieve candidates: top 5 by vector similarity within the scope (and inherited scopes) restricted to `semantic` kind, plus facts sharing ≥ 1 entity with the same relation type.
2. Run the NLI classifier on (existing, new) and (new, existing); take the max contradiction probability.
3. If `p_contradict ≥ θ_c` (default 0.80) → conflict. If `p_entail ≥ 0.90` → duplicate (link `supports`, lower importance of the new one). Else → independent.
4. A conflict creates `s/conflict/(scope, conflictId)` = `{ a, b, scores, detectedAt, status: 'open', policy }` and the new fact is stored with `trust = quarantined` (unless the tenant policy is `newest_wins`).

**Resolution** (`MEM.RESOLVE id KEEP a|b|both [VALID_FROM t]`): `both` with validity windows models a real change ("user was vegetarian until 2026-03"); the losing fact gets `validTo`, never deletion.

**Policies per scope**: `quarantine_new` (default), `newest_wins`, `ask_human`, `prefer_source(verified)`.

**Quality targets**: build a labelled set of 300 fact pairs (contradict/entail/neutral) from LoCoMo-style dialogues; report precision and recall; tune θ_c.

### 13.3 Point-in-time recall (`ASOF`)

- `ASOF index` → MVCC read at that index.
- `ASOF time` → read at that HLC (versions are HLC timestamps, 10.2 / ADR-0027).
- Indexes: HNSW is current-state only, so `ASOF` recall runs vector search on current index with `k × 4`, then reads each candidate at the `ASOF` version and drops those that did not exist then; for old timestamps beyond index coverage it falls back to scanning BM25 + entity retrievers over the version-filtered records. Document the accuracy trade-off.
- Bitemporal queries: `VALID_AT t` filters on world-time `validFrom/validTo` (Graphiti-style), independent of `ASOF` (system time).

### 13.4 Provenance and quarantine

- Every record stores `source` and `principal`; derived records (consolidation outputs, theme summaries, evolved versions) store `derived_from` links.
- **Trust policy** by source: `user` → normal; `agent` → normal; `tool` → normal if tool is on the allow-list else quarantined; `web`/`document` → quarantined unless the tenant marks the domain trusted; `consolidation` → inherits the minimum trust of its inputs.
- Quarantined memories are excluded from recall by default (`INCLUDE_QUARANTINED` to see them) and shown in the dashboard for review.
- **Taint cascade**: `MEM.FORGET SOURCE <ref>` walks `derived_from` links and forgets or re-derives everything built from that source (transitively), in one replicated command per range.
- Prompt-injection defense: quarantined text is never fed to the Extractor/Summarizer prompts as instructions; it is wrapped as quoted data with a fixed system instruction.

### 13.5 Change streams (watch)

- `MEM.WATCH scope [FROM index]`, MCP resource subscriptions, SSE `/api/realtime`, SDK `subscribe()`.
- Cursor = `(rangeId, index)`; resumable; filtered by the subscriber's permissions.
- Event types: `memory.added`, `memory.evolved`, `memory.forgotten`, `conflict.raised`, `conflict.resolved`, `branch.merged`, `record.created|updated|deleted`, `cache.invalidated`.

### 13.6 Token-budget recall (`MEM.PACK`)

- Input: ranked candidates with scores and token counts (tokenizer configurable; default an approximate tokenizer of 4 characters ≈ 1 token, or `tiktoken`-compatible BPE when configured).
- Algorithm: greedy by `score / tokens` with an MMR diversity penalty, then a 1-pass improvement that swaps a low-value packed item for a higher-value unpacked one if it fits. Optional **compression**: when an item is too long, include its summary instead of the full text.
- Output: ordered list grouped by kind (facts, recent episodes, themes, procedures) with a header line per group, plus `{ usedTokens, budget, dropped }`.

### 13.7 Cognitive eviction and the forgetting curve

- Retention `R = e^(−t/S)` where t = days since last recall (or creation), S = strength in days. New memories start at `S₀ = 1 + 9 × importance` days.
- On each recall: `S ← S × (1 + 0.5 × spacingFactor)` where `spacingFactor = min(1, t / S)` (rewards spaced recalls, MemoryBank's spacing effect).
- Tiering: `R < 0.2` and not pinned → cold tier. `R < 0.02` and `importance < 0.2` and not referenced by links from hot memories → eligible for deletion only if the tenant enables hard forgetting (default off).
- Under memory pressure (RSS above the configured cap), the node evicts **in-memory index entries** of the lowest-retention memories first (they remain on disk), replacing LRU.

### 13.8 Scope-aware and semantic sharding

Specified in 8.5. Additional requirement: recall over a semantically split scope fans out to at most 2 ranges by default; measure and publish recall@10 vs single range.

### 13.9 Memory-aware semantic cache

- `CACHE.SET scope prompt answer USING id1 id2 … [TTL s]` and MCP `cache_store`. Stores prompt embedding, answer, dependency set (memory ids and record keys), model hint, created HLC.
- `CACHE.GET scope prompt [THRESHOLD 0.92]`: two stages, as in GPTCache's `data_manager` → `similarity_evaluation` split: (1) ANN search over cache-entry embeddings in scope for candidates; (2) a pluggable `SimilarityEvaluator` (cosine threshold by default, local cross-encoder optional) confirms the match. Hit only if confirmed **and** no dependency changed since the entry's HLC.
- Two levels (GPTCache's `next_cache` idea): L1 per-node in-process LRU on exact normalised prompt hash, L2 replicated semantic cache.
- Invalidation: the `CacheInvalidator` subscribes to `MemoryCommitted`/`RecordChanged`; a reverse index `q/dep/(memoryId) → cacheIds` lets it propose `CacheInvalidate` for affected entries.
- Metrics: hit rate, false-positive rate (sampled human/LLM judgment in evals), tokens saved.

### 13.10 Embedded replicas (SDK)

- `MindlogClient({ embeddedReplica: { path: './.mindlog', scopes: [...] } })` keeps a local LevelDB with the subscribed scopes' records and a local brute-force/HNSW index.
- Bootstrap: download a scope snapshot (`snapshot(t)` read), then follow the change stream from that index.
- Reads served locally (session consistency: the SDK waits until its local index ≥ the index returned by its own last write). Writes go to the leader.
- Offline: reads keep working; writes queue locally with request ids and replay on reconnect (idempotent).

### 13.11 Memory cubes (export/import) and tool traces

- **Export**: `MEM.EXPORT scope [ASOF index]` writes a `.mcube` file: a tar of `manifest.json` (scope, index, HLC, model ids, counts, checksum, optional signature), `memories.jsonl`, `entities.jsonl`, `edges.jsonl`, `branches.json` and optionally `vectors.bin`.
- **Import**: native `.mcube`, or COGX (Cognee's exchange format) for migration from Mem0, Letta, Zep or Graphiti exports. Imported memories carry `source.type = 'document'`, `ref = import:<file>` and follow trust policy.
- **Tool traces**: `remember` accepts `{ kind: 'tool_trace', tool, args, result, success }`; stored as procedural memory; recall of "how did I do X before" uses them. Large results are truncated to a summary.

---

## 14. Model service (Python sidecar)

### 14.1 Responsibilities

Stateless inference over gRPC on localhost. No access to the database. Easy to restart, scale, or replace.

### 14.2 Models (defaults, all CPU-friendly; swap via config)

| Capability | Default model family | Notes |
|---|---|---|
| Embeddings | all-MiniLM-L6-v2 (384-d) via sentence-transformers | Upgrade path: a stronger small embedder (e.g., BGE-small, GTE-small) |
| Entity recognition | GLiNER (small/medium) | Zero-shot labels |
| NLI | A small NLI cross-encoder (DeBERTa-v3 small/xsmall class) | Contradiction/entailment/neutral |
| Reranker | A small cross-encoder reranker (MiniLM class) | Optional |
| Fact extraction / summaries | 1–3B instruct model in GGUF via llama-cpp-python | JSON-schema constrained output (grammar) |

Check licenses of each chosen checkpoint and record them in `python/model_service/MODELS.md`.

### 14.3 API (`proto/models.proto`)

```proto
service Models {
  rpc Embed(EmbedRequest) returns (EmbedResponse);                 // batch of texts, kind=query|passage
  rpc RecognizeEntities(NerRequest) returns (NerResponse);
  rpc ClassifyNli(NliRequest) returns (NliResponse);
  rpc Rerank(RerankRequest) returns (RerankResponse);
  rpc ExtractFacts(ExtractRequest) returns (ExtractResponse);      // JSON-schema output
  rpc Summarize(SummarizeRequest) returns (SummarizeResponse);
  rpc Health(HealthRequest) returns (HealthResponse);              // model ids, versions, queue depth
}
```

### 14.4 Runtime design

- Async gRPC server (`grpc.aio`) with a **micro-batcher** per model: collects requests for up to 5 ms or 32 items, runs one forward pass.
- Separate process pools for heavy models (LLM) so a long generation does not block embeddings.
- Admission control: max queue depth per method; reject with `RESOURCE_EXHAUSTED` so the server switches to degraded mode rather than piling up latency.
- Warm-up on start; `/health` reports ready only after all enabled models load.
- Deterministic settings for extraction (temperature 0, fixed seed) to make results reproducible; the server still treats outputs as non-deterministic (only the leader calls models).

### 14.5 Model versioning

Every output carries `modelId@version`. Records store the embedding model id. Changing the embedding model creates a new index generation per scope: the `ReembedWorker` fills it in the background; recall uses the old generation until the new one reaches 100%, then switches atomically (a replicated `IndexGenerationSwitch` command).

### 14.6 Optional remote models

An `OpenAICompatibleExtractor` / `AnthropicExtractor` adapter MAY be configured per tenant for higher-quality extraction when the deployment is allowed online. Offline remains the default.

---

## 15. External interfaces

All adapters translate wire formats into the same application-layer request types, so a feature implemented once is reachable through every interface.

### 15.1 RESP3 (Redis protocol)

**Connection handling**: one TCP server (`net`), per-connection parser state, pipelining (process frames in order, write replies in order), `HELLO 3` negotiation (RESP2 fallback for old clients), `AUTH user pass`, `CLIENT SETNAME/ID/INFO`, max connections, idle timeout, output buffer limits per connection (close slow consumers).

**Supported command set (v1)**

| Group | Commands |
|---|---|
| Connection | `PING` `ECHO` `HELLO` `AUTH` `SELECT 0` `QUIT` `CLIENT …` `RESET` |
| Server | `INFO` `DBSIZE` `TIME` `COMMAND` `COMMAND DOCS` `CONFIG GET` (read-only subset) |
| Keys | `DEL` `UNLINK` `EXISTS` `EXPIRE` `PEXPIRE` `EXPIREAT` `TTL` `PTTL` `PERSIST` `TYPE` `RENAME` `SCAN` `KEYS` (guarded) |
| Strings | `GET` `SET` (EX/PX/NX/XX/GET/KEEPTTL/IFEQ) `MGET` `MSET` `INCR` `INCRBY` `DECR` `APPEND` `GETDEL` `GETEX` `STRLEN` `SETRANGE` `GETRANGE` |
| Hashes | `HGET` `HSET` `HMGET` `HDEL` `HGETALL` `HKEYS` `HVALS` `HLEN` `HEXISTS` `HINCRBY` `HSCAN` |
| Lists | `LPUSH` `RPUSH` `LPOP` `RPOP` `LRANGE` `LLEN` `LINDEX` `LSET` `LTRIM` `BLPOP`/`BRPOP` (stretch) |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SCARD` `SPOP` `SINTER` `SUNION` `SDIFF` `SSCAN` |
| Sorted sets | `ZADD` `ZREM` `ZSCORE` `ZRANGE` (BYSCORE/BYLEX/REV/LIMIT) `ZRANK` `ZINCRBY` `ZCARD` `ZCOUNT` `ZSCAN` |
| Streams | `XADD` `XRANGE` `XREVRANGE` `XLEN` `XREAD` `XGROUP` `XREADGROUP` `XACK` `XPENDING` (stretch) |
| JSON | `JSON.SET` `JSON.GET` `JSON.DEL` `JSON.MGET` (path subset) |
| Transactions | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| Pub/Sub | `SUBSCRIBE` `PUBLISH` `PSUBSCRIBE` (node-local fan-out + cluster forwarding) |
| Indexes | `IDX.CREATE` `IDX.DROP` `IDX.QUERY` |
| Memory | `MEM.ADD` `MEM.SEARCH` `MEM.PACK` `MEM.GET` `MEM.HISTORY` `MEM.FORGET` `MEM.IMPROVE` `MEM.BRANCH` `MEM.MERGE` `MEM.DROP` `MEM.DIFF` `MEM.CONFLICTS` `MEM.RESOLVE` `MEM.WATCH` `MEM.EXPORT` `MEM.IMPORT` |
| Graph | `GRAPH.QUERY scope entity [DEPTH n]` `GRAPH.ENTITY` `GRAPH.PPR scope entity…` |
| Cache | `CACHE.GET` `CACHE.SET` `CACHE.DEL` `CACHE.STATS` |
| Admin | `CLUSTER.INFO` `CLUSTER.ADDLEARNER` `CLUSTER.PROMOTE` `CLUSTER.REMOVE` `CLUSTER.TRANSFER` (phase 3, ADR-0006) `CLUSTER.RANGES` `ADMIN …` (superuser) |

Unsupported commands return `-ERR unknown command` with a link to the compatibility table in docs. Compatibility is verified by running a subset of the official Redis test suite and popular client libraries' integration tests (ioredis, redis-py) against Mindlog.

### 15.2 MCP server

**Transports**: stdio (local agents) and Streamable HTTP on 8765 (remote agents). **Auth** on HTTP: bearer tokens (API keys or OAuth 2.1 access tokens following the MCP authorization specification); stdio inherits local trust but still requires an API key in config to pick the tenant and scope.

**Tools** (JSON-schema input and output; every tool returns structured content and a short text summary):

| Tool | Input (main fields) | Output |
|---|---|---|
| `remember` | `content` (text or messages[]), `scope`, `kind?`, `source?`, `async?` | ids, conflicts, degraded flag |
| `recall` | `query`, `scope`, `token_budget?`, `mode?` (hybrid/ppr/theme), `asof?`, `valid_at?`, `branch?`, `include_quarantined?` | packed context text + structured items + explain |
| `forget` | `id` or `source` or `scope`, `cascade?` | counts |
| `improve` | `scope`, `what?` (consolidate/dedupe/themes) | job ids |
| `branch` / `merge` / `discard` / `diff` | `scope`, `name`, `policy?` | branch status, merge report |
| `history` | `scope`, `id` or `asof` | versions |
| `conflicts` / `resolve_conflict` | `scope` / `id`, `keep`, `valid_from?` | conflict list / result |
| `graph_query` | `scope`, `entity`, `depth?` | nodes, edges |
| `cache_lookup` / `cache_store` | `scope`, `prompt`, `answer?`, `depends_on?` | hit/miss, answer |
| `export_scope` / `import_scope` | `scope`, `asof?` / file ref | file ref / counts |
| `kv_get` / `kv_set` (optional) | key, value | value |
| `collection_query` (full-stack mode) | `collection`, `filter`, `sort`, `limit` | records (rules applied as the acting user) |

**Resources**: `memory://{scope}/{id}`, `memory://{scope}/recent`, `graph://{scope}/entity/{name}`, `conflicts://{scope}`, with subscriptions backed by the change stream.

**Prompts**: `recall-context` (inserts packed memories for a task), `reflect-session` (asks the agent to summarise and `remember` lessons at session end).

**Design rules**: tool descriptions written for models (what, when, limits); outputs bounded in size; errors returned as tool results with actionable messages, not protocol errors; every call traced with the agent's client name.

### 15.3 REST API (port 8090)

- `/api/admin/*` — cluster, ranges, nodes, jobs, settings, users, API keys (superuser/admin).
- `/api/kv/*` — browse and edit keys (dashboard).
- `/api/memory/*` — REST mirror of memory operations.
- `/api/collections/*`, `/api/files/*`, `/api/realtime` — full-stack mode (section 16).
- `/health` (liveness), `/ready` (readiness: storage open, Raft ready, PD reachable), `/metrics` (Prometheus).
- OpenAPI 3.1 spec generated from route schemas (Fastify + TypeBox/Zod) and published in docs; the dashboard and SDKs are generated from it where practical.
- Errors follow RFC 9457 problem details: `{ type, title, status, detail, instance, code }`.
- Pagination: cursor-based for scans; `page/perPage` for collections (PocketBase-compatible shape).

### 15.4 Public gRPC (port 9090)

Services: `KvService`, `MemoryService`, `GraphService`, `CacheService`, `CollectionService`, `AdminService`, `WatchService` (server streaming). Deadlines required on every call; retries via gRPC retry policy for idempotent methods.

### 15.5 SDKs

| SDK | Features |
|---|---|
| `@mindlog/sdk` (TypeScript) | Typed client for REST/gRPC, memory API, collections API with realtime, embedded replica (Node only), retries, request ids |
| `mindlog` (Python) | Same surface; LangGraph store/checkpointer integration; CrewAI memory adapter |

---

## 16. Full-stack backend mode

PocketBase-inspired; optional; enabled per tenant.

### 16.1 Collections

- Types: `base`, `auth`, `view`.
- Schema stored at `s/schema/(collection)` and changed only through `SchemaChange` commands (versioned; migrations are files under `migrations/` applied in order and recorded).
- Records under `c/(collection, id)`; ids are 15-char random strings (PocketBase-style) or ULIDs (config).
- System fields: `id`, `created`, `updated`; auth collections add `email`, `emailVisibility`, `verified`, `password` (hash), `tokenKey`.

### 16.2 Field types

`text`, `number`, `bool`, `email`, `url`, `editor` (sanitized HTML), `date`, `autodate`, `select` (single/multi), `file` (single/multi), `relation` (single/multi, cascade delete option), `json`, `geoPoint`, plus Mindlog-specific `vector` (auto-embedded from a source field) and `memory` (link to a memory record). Field modifiers (`field+`, `field-`, `+field`) supported on number/select/relation/file as in PocketBase.

### 16.3 Rules engine (`@mindlog/rules`)

**Rule slots per collection**: `listRule`, `viewRule`, `createRule`, `updateRule`, `deleteRule` (+ `manageRule` on auth collections). `null` = superusers only (default); `""` = anyone; otherwise a filter expression that must match.

**Grammar (EBNF)**:

```ebnf
expr        = orExpr ;
orExpr      = andExpr { "||" andExpr } ;
andExpr     = unary { "&&" unary } ;
unary       = "(" expr ")" | comparison ;
comparison  = operand op operand ;
op          = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~"
            | "?=" | "?!=" | "?>" | "?>=" | "?<" | "?<=" | "?~" | "?!~" ;
operand     = literal | identifier | function ;
identifier  = field { "." field } [ ":" modifier ]
            | "@request." path [ ":" modifier ]
            | "@collection." name [ ":" alias ] "." path
            | macro ;
modifier    = "isset" | "changed" | "length" | "each" | "lower" ;
macro       = "@now" | "@todayStart" | "@todayEnd" | "@monthStart" | "@yearStart" | … ;
function    = "geoDistance(" args ")" | "strftime(" args ")" ;
literal     = string | number | "true" | "false" | "null" ;
```

**Pipeline**: lexer → parser (AST) → type checker (against schema; errors with positions for the dashboard editor) → planner (pick a secondary/unique index for the most selective indexed predicate; relation lookups become index joins; `@collection` becomes a semi-join) → evaluator (for writes: evaluate against `@request.body` and the existing record; for lists: filter + index scan with a cap and a cursor).

**Semantics**: rules also filter lists (non-matching records are simply absent); status codes follow PocketBase conventions (200 empty list for list rule, 404 for view/update/delete rule, 400 for create rule, 403 for locked when not superuser). Superusers bypass rules.

**Fuzzing**: grammar-based fuzzer for the parser; property tests that the planner's result equals a naive full-scan evaluation.

### 16.4 Authentication

- Password (argon2id), OTP via email (SMTP config; offline deployments can log OTPs to console in dev), OAuth2 (Google, GitHub, generic OIDC) with PKCE.
- Tokens: short-lived JWT access tokens (15 min) signed with a rotating key set; refresh tokens stored hashed in `s/session/…`; changing `tokenKey` revokes all sessions of a user.
- API keys for services and agents: prefix-identified, hashed at rest, scoped (`collections:read`, `memory:write:tenant/user/*`), expirable.
- Email verification and password reset flows; rate-limited.
- **Agents on behalf of users**: an agent may exchange its API key + a user's access token for a delegated token whose principal is the user and actor is the agent (both recorded in audit); rules evaluate as the user.

### 16.5 Files

- `BlobStore` port: local disk (single node) or S3-compatible (MinIO for offline clusters).
- Upload flow: stream to blob store under a content hash → propose `RecordWrite` with file metadata → on failure, a janitor job removes orphan blobs.
- Download: `/api/files/{collection}/{recordId}/{filename}` with rule check (`viewRule`) and optional short-lived file tokens for protected files; image thumbnails generated lazily (sharp) and cached.

### 16.6 Realtime

`/api/realtime` SSE: client subscribes to `collection/*` or `collection/id`; server filters each change event through `listRule`/`viewRule` evaluated as the subscriber; reconnects resume from the last event id (= `(rangeId,index)`).

### 16.7 View collections

Defined with a small JSON pipeline instead of SQL: `[{ from: "posts" }, { join: { collection: "comments", on: "comments.post = posts.id", type: "left" } }, { group: ["posts.id", "posts.name"], aggregate: { totalComments: "count(comments.id)" } }]`. Maintained incrementally by a view maintainer subscribed to the change stream, materialized under `c/(view, id)`, so views get realtime events (an improvement over PocketBase views).

### 16.8 Hooks, jobs, migrations

- Hooks: `onRecordCreate/Update/Delete` (before/after), `onAuth`, `onFileUpload`, written in TypeScript in a `hooks/` folder, executed in a worker-thread sandbox with time and memory limits; "before" hooks run on the leader before proposing, "after" hooks run once on the leader after commit (tracked by job ids so they are not repeated on leader change).
- Scheduled jobs: cron expressions; run by the range leader of a system range.
- Migrations: ordered files, each a function receiving a migration API; applied in a transaction-like sequence of `SchemaChange` commands; recorded in `s/migrations`.

---

## 17. Admin dashboard

### 17.1 Technology

React + Vite + TypeScript, Tailwind CSS v4 and shadcn/ui components (ADR-0023), Cytoscape.js (graph), a virtualized grid for tables, CodeMirror for the console and rule editor (with rule-language autocomplete from the type checker). Built assets are served by `adapter-http` at `/_/`; no CDN calls (works offline).

### 17.2 Pages

| Page | Capabilities |
|---|---|
| Overview | Cluster health, nodes, QPS, latency, memory counts, model service status, open conflicts, failing jobs |
| Data browser | Keys by prefix/type, typed editors per Redis type, TTL, console (RESP commands over WebSocket proxy) |
| Collections | Schema editor, field types, rule editor with autocomplete and live validation, record grid with filters, file previews, users |
| Memory explorer | Filter by scope/kind/source/trust/tier/branch; record detail with provenance chain, version history (evolution), links, entities; edit/verify/forget |
| Knowledge graph | Interactive entity graph; click node → memories; PPR visualizer for a query |
| Recall playground | Run a query as an agent: per-retriever results, fusion, scores, packing result, cache hit/miss, latency per stage |
| Time travel | Slider over HLC/index; explorer and graph redraw at that point |
| Branches | List, diff vs main, merge with policy, drop |
| Conflicts inbox | Side-by-side facts, NLI scores, resolve actions, bulk actions |
| Live feed | Change stream with filters |
| Jobs | Queues, leased/failed/dead jobs, retry/cancel |
| Cluster | Nodes, ranges (size, QPS, leader, replicas), PD operators, drain/transfer/split actions |
| Logs & audit | Structured logs (recent), audit trail with filters |
| Settings | Tenants, admins, ACL users, API keys, OAuth providers, SMTP, models, retention, file storage, backups, feature flags |

### 17.3 Security

Superuser/admin login with MFA (TOTP) option; bearer tokens rather than cookie sessions, so no CSRF surface (ADR-0024); CSP headers; every mutation goes through the same REST API with the same authorization and audit as external clients.

---

## 18. Security and multi-tenancy

### 18.1 Threat model (STRIDE summary)

| Threat | Example | Mitigation |
|---|---|---|
| Spoofing | Forged node joins the cluster | mTLS between nodes with a cluster CA; join tokens |
| Spoofing | Stolen API key | Hashed at rest, scoped, expirable, revocable; anomaly alerts on unusual scope use |
| Tampering | Modified log on disk | CRC32C per entry, checksums per snapshot chunk; optional encryption at rest |
| Tampering | Memory poisoning via web content or prompt injection | Quarantine by source, NLI conflict check, provenance + taint cascade, never treating stored text as instructions |
| Repudiation | "The agent never wrote that" | Every command records principal, actor, client name and request id; append-only audit log |
| Information disclosure | Tenant A reads tenant B | Tenant prefix on every key, authorization at the application layer, per-tenant encryption keys, tests that fuzz cross-tenant access |
| Information disclosure | PII in memories | Optional redaction stage, per-tenant retention, `forget` by user with audit |
| Denial of service | One tenant floods writes or model calls | Per-tenant rate limits, quotas, model-seconds budgets, admission control, connection limits |
| Elevation of privilege | Agent token used to change rules | RBAC; agents cannot hold admin roles; rule changes need admin + audit |

### 18.2 Identity and roles

| Role | Can |
|---|---|
| `superuser` | Everything, including cluster operations |
| `tenant_admin` | Manage a tenant's settings, users, keys, collections, rules, models |
| `developer` | Read/write data and memory in a tenant, cannot change security settings |
| `agent` | Memory operations within granted scopes; optional KV/collection access through rules |
| `app_user` | Full-stack mode end user; governed by collection rules |
| `readonly` | Read data, dashboards, metrics |

Authorization decisions use `(principal, action, resource)` with resources expressed as scope paths or collection names; policies are data (stored and replicated), evaluated by `@mindlog/auth`.

### 18.3 Multi-tenancy

- Hard isolation by key prefix and authorization; optional placement rules to pin a tenant to dedicated nodes.
- Quotas per tenant: storage bytes, keys, memories, write QPS, recall QPS, model-seconds/hour, connections. Enforced at the router (fast reject) and recorded in metrics.
- Rate limiting: token buckets per (tenant, operation class) held locally per node with periodic budget redistribution by PD (approximate global limit without a hot central counter).

### 18.4 Transport and secrets

- TLS for RESP, HTTP, gRPC (optional for local dev, required in `production` profile).
- mTLS for node↔node and node↔PD; certificates rotated without downtime (hot reload).
- Secrets (master key, OAuth client secrets, SMTP) from environment or files with restricted permissions; never logged; redaction filter in the logger.

### 18.5 Audit log

Append-only system family `s/audit/(tenant, hlc, id)`: who, acting-for, what, resource, request id, result. Exportable; retained per policy; viewable in the dashboard.

### 18.6 Supply chain

Lockfiles committed; `pnpm audit` and `pip-audit` in CI; SBOM generation (CycloneDX) per release; pinned model checkpoints with checksums; container images built from minimal bases and scanned.

---

## 19. Observability and operations

### 19.1 Metrics (Prometheus, `prom-client`)

| Area | Metrics |
|---|---|
| RESP/HTTP/gRPC/MCP | requests by command/tool, errors, latency histograms, active connections |
| Raft | proposals, commit latency, apply latency, leader changes, elections, log size, snapshot count/duration, follower lag (entries) |
| Multi-Raft | ranges per node, leaders per node, quiescent ranges, splits/merges, range QPS |
| Storage | LevelDB size, compaction time, write stall time, GC versions removed |
| Indexes | HNSW size per scope, search latency, rebuilds; BM25 postings; graph nodes/edges; PPR latency |
| Memory engine | per-stage latency and errors, degraded-mode count, conflicts raised/resolved, quarantined count, cache hit rate, packing utilization |
| Jobs | queue depth by queue/tenant, lease expirations, retries, dead letters |
| Model service | per-method latency, batch size, queue depth, rejections, model load state |
| Tenancy | quota usage, rate-limit rejections |
| Process | event-loop lag, heap, RSS, GC pauses, worker-thread utilization |

### 19.2 Tracing and logging

- OpenTelemetry tracing across adapters → router → leader → Raft propose → apply → model calls (W3C trace context propagated over gRPC to Python).
- Structured JSON logs (`pino`) with trace ids, tenant, range id; log levels per module at runtime via admin API.
- Sampling: 100% of errors, 1–5% of successes (configurable).

### 19.3 Health, readiness and SLO alerts

- `/health`: process alive. `/ready`: storage open, at least catching up on all local ranges, PD reachable, model service state reported (not required for readiness — degraded is allowed).
- Example alerts: leader changes > 5/min on a range; follower lag > 10,000 entries; event-loop lag p99 > 100 ms; disk > 85%; model service down > 5 min; dead-letter jobs > 0; clock offset > 250 ms.

### 19.4 Operations runbooks (write in `docs/runbooks/`)

Node crash and replacement · disk full · leader flapping · slow follower · model service down · PD quorum loss · restore from backup · rolling upgrade · rotating certificates · rotating master key · tenant data export and deletion.

### 19.5 Upgrades and compatibility

- Semantic versioning; on-disk format version and Raft command version recorded; nodes refuse to start on an unknown newer format.
- Rolling upgrades: new nodes accept old command versions; new command types are gated behind a cluster version that PD bumps only when all nodes run the new binary (feature flags keyed by cluster version).

### 19.6 Configuration

Layered: defaults → `mindlog.yaml` → environment variables (`MINDLOG_*`) → CLI flags. Validated with a schema at startup; tenant-level settings stored in the database and changeable at runtime. See Appendix B.

---

## 20. Scalability and performance engineering

### 20.1 Scaling model

- **Horizontal**: data scales by ranges; adding a node triggers PD rebalancing. Memory scopes scale by scope placement and semantic split.
- **Compute**: model service scales per node; heavy consolidation work is throttled per tenant and runs on leaders, spreading naturally with leader balancing.
- **Read scaling**: follower and bounded-staleness reads spread recall across replicas; embedded replicas move reads into agents.

### 20.2 Node.js-specific practices

- Keep the event loop free: anything > 1 ms of CPU (vector search on large scopes, PPR, packing, BM25 scoring of many candidates, snapshot encoding, JSON parsing of huge payloads) runs in a `worker_threads` pool (Piscina) with bounded queues.
- Zero-copy where possible: `Buffer`/`Uint8Array` slices for RESP parsing and key encoding; avoid string concatenation on hot paths.
- Batching everywhere: Raft proposals per tick, LevelDB writes per Ready cycle, model calls via micro-batching, change-stream fan-out per tick.
- Backpressure: per-connection output buffer limits; per-range proposal queue limits (reject with `BUSY`); job queue limits.
- Load shedding: when event-loop lag p99 > threshold, reject low-priority work (consolidation, analytics scans) before user requests.

### 20.3 Capacity planning worksheet (fill in during phase 11)

| Input | Measure |
|---|---|
| Bytes per memory record (text + metadata + vector 1.5 KB) | ___ |
| HNSW RAM per 100K vectors (384-d) | ___ |
| Recall p95 at 10K / 100K / 1M per scope | ___ |
| Writes/s per range (KV) at p99 < 15 ms | ___ |
| Extraction throughput per CPU core (facts/s) | ___ |

### 20.4 Performance test plan

`redis-benchmark` and `memtier_benchmark` for KV (1 vs 3 nodes, pipelining 1/16); custom k6 or Node load generator for MCP/REST recall; ingestion throughput with and without extraction; failover under load; publish flame graphs (`0x`/`clinic`) of hot paths before and after optimization.

---

## 21. Fault tolerance and degradation

| Failure | Detection | Behaviour |
|---|---|---|
| Follower crash | Missed heartbeats | No impact on writes (majority remains); PD re-replicates after 5 min |
| Leader crash | Election timeout | New leader in 1–3 s; clients retry via router; lease reads pause until new lease |
| Network partition | CheckQuorum, PreVote | Minority side stops serving writes and linearizable reads; bounded-staleness reads continue if allowed |
| Slow follower | Lag metric | Leader throttles in-flight; sends snapshot if follower falls behind compacted log |
| Disk full | Write error | Node fail-stops affected ranges; alerts; PD moves replicas away |
| Disk corruption | CRC mismatch | Replica marks itself corrupt, deletes local data for that range, re-fetches a snapshot from peers |
| Clock skew | HLC offset check | Node refuses leases, alerts; correctness preserved (leases off) |
| PD quorum loss | PD RPC failures | Data path continues with cached range map; no splits/moves/TSO (cross-range txns pause) |
| Model service down | Health checks | Degraded mode: raw episodic storage, enrichment jobs queued, recall without rerank/NER (vector+BM25 only if embedder up; BM25-only if not) |
| Python model hang | Per-call deadlines | Circuit breaker opens after N timeouts; half-open probes |
| Poison command (bug) | Apply exception | Deterministic validation errors are stored as results; unexpected exceptions fail-stop the replica and alert (never skip an entry) |
| Runaway tenant | Quotas | Rejected with `QUOTA_EXCEEDED`/`BUSY`; other tenants unaffected |

---

## 22. Testing strategy

### 22.1 Test pyramid

| Level | Tools | Scope | Gate |
|---|---|---|---|
| Unit | Vitest | Pure logic: encoders, RESP parser, rules parser, scoring, packing, CRDT merges, Raft state machine | Every PR; ≥ 85% line coverage on domain packages |
| Property-based | fast-check | Key encoding order preservation, MVCC visibility, merge commutativity, rules planner ≡ naive evaluation, RRF properties | Every PR |
| Contract | Protobuf compatibility (buf breaking), recorded gRPC fixtures TS↔Python | Model service API, internal RPCs | Every PR |
| Integration | Vitest + real LevelDB + real model service (small models) | Module combinations, adapters | Every PR (fast subset), nightly (full) |
| Deterministic simulation | Custom simulator (`test/sim`) | Whole cluster in one process with simulated network/disk/clock; random faults; invariant checks | 1,000 seeds per PR, 100,000 nightly; failing seeds saved as regression tests |
| Linearizability | Jepsen Maelstrom `lin-kv` (and `txn-list-append` for transactions later) | Raft + KV correctness under partitions | Phase 3+ nightly |
| Compatibility | Redis client libraries' test suites (subset), `redis-benchmark` | RESP behaviour | Phase 1+ nightly |
| Chaos | Docker Compose + `tc`/iptables + kill -9 | Real processes | Weekly and before releases |
| Fuzzing | Grammar fuzzers (RESP frames, rule expressions, JSON paths) | Parsers | Nightly |
| Load/performance | redis-benchmark, memtier, custom generators | SLOs | Phase 11, then per release |
| AI evaluation | Section 22.7 | Recall quality, conflicts, cache | Phases 5–8 per change to memory engine |
| Security | Authz matrix tests, cross-tenant fuzzing, dependency audit | Isolation | Every PR (matrix), nightly (fuzz) |

### 22.2 Deterministic simulator (key to enterprise-grade correctness)

- Single process, single thread; all I/O through ports with simulated implementations: `SimNetwork` (latency distributions, drop, duplicate, reorder, partition schedules), `SimDisk` (fsync semantics, crash loses unsynced data, torn last write), `SimClock` (per-node drift), `SimRandom` (seeded).
- Scenario DSL: `cluster(5).run(workload).withFaults(partitionEvery(5s), crashRandomNode(10s)).for(60s).check(invariants)`.
- Invariants: Raft safety (7.5), linearizable history (checked with a small Wing–Gong checker for KV), no lost acknowledged writes, all replicas converge to identical state hashes after healing, memory engine invariants (no recall returns a quarantined item unless requested; branch reads never see post-fork main writes).

### 22.3 Test data

Synthetic dialogue generator for memory (multi-session conversations with planted facts, preference changes and contradictions); public eval sets (LoCoMo, LongMemEval); a labelled contradiction set (300+ pairs); collections fixtures (todo app, store app).

### 22.4 Python service tests

pytest unit tests per endpoint with tiny models; golden-output tests for extraction JSON schema; load test for micro-batcher.

### 22.5 CI pipeline (GitHub Actions)

1. Install (pnpm, uv) with caches → 2. Lint + typecheck + boundary rules + circular-dependency check → 3. Unit + property tests → 4. Protobuf breaking-change check → 5. Integration (fast) → 6. Simulation (1,000 seeds) → 7. Build dashboard + server + Docker images → 8. SBOM + audit.
Nightly: full integration, 100k simulation seeds, Maelstrom, fuzzers, AI evals (small budget).

### 22.6 Definition of a flaky test

Any test that fails without a code change is quarantined within 24 h, tracked in an issue, and fixed or deleted within a week. Simulation failures are never flaky: they come with a seed and must be reproduced.

### 22.7 AI evaluation harness (`python/evals`)

| Eval | Metric | Baselines |
|---|---|---|
| LongMemEval, LoCoMo | Accuracy (LLM judge, fixed judge model and prompt) | Mem0 OSS, Cognee, Redis Agent Memory Server, plain vector RAG |
| Retrieval ablations | recall@k, MRR for each retriever and fusion combination | vector-only |
| Conflict detection | precision, recall, F1 at θ_c | last-write-wins (no detection) |
| Semantic cache | hit rate, false-positive rate, tokens saved | no cache, exact-match cache |
| Packing | answer accuracy vs token budget curve | top-k truncation |
| Forgetting | accuracy on old-but-important facts after N sessions | LRU eviction |

All eval configs, seeds and model ids are committed; results are written to `docs/evals/<date>.md`.

---

## 23. Engineering standards and CI/CD

### 23.1 TypeScript

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; ESM only; Node LTS.
- Errors: domain code returns `Result<T, E>` for expected failures; throws only for programmer errors. Error codes are a closed enum (`MindlogErrorCode`) mapped to RESP errors, HTTP problem types, gRPC status and MCP tool errors in one table.
- `bigint` for indexes, terms and HLC; never `number` for log positions.
- Lint: ESLint (typescript-eslint strict), `eslint-plugin-boundaries` for layer rules, Prettier. `madge` for cycles.
- Each package: `src/`, `test/`, `README.md` (purpose, public API, invariants), `index.ts` as the only public entry.

### 23.2 Python

Python 3.12+, `uv` for env, `ruff` (lint+format), `mypy --strict` on service code, pytest.

### 23.3 Protobuf

`buf` for lint, breaking-change detection and codegen (TypeScript via protobuf-es; Python via grpcio-tools). Field numbers never reused.

### 23.4 Repository conventions

- Conventional Commits; changesets for versioning; trunk-based development with short-lived branches; PR template with "tests added", "ADR needed?", "docs updated".
- ADRs in `docs/adr/NNNN-title.md` (context, decision, alternatives, consequences).
- Code owners per package (even solo, it documents responsibility).

### 23.5 Releases and delivery

- Release artifacts: Docker images (`mindlog-server`, `mindlog-models`), single-file server binary (Bun compile) for dev use, npm and PyPI SDKs, dashboard bundled.
- `docker-compose.yml` profiles: `dev` (1 node), `cluster` (3 nodes + 3 PD + MinIO + Prometheus + Grafana + Jaeger), `chaos`.
- Helm chart (stretch) for Kubernetes: StatefulSet per node, PodDisruptionBudget, anti-affinity across zones.

### 23.6 Final repository layout

```
mindlog/
  CLAUDE.md
  README.md
  docs/
    PLAN.md                     this file
    design.md                   architecture doc (exported)
    adr/                        decision records
    runbooks/
    evals/
    api/                        OpenAPI, MCP tool reference, RESP compatibility table
  proto/                        *.proto (commands, raft, internal, public, models)
  packages/
    core/  proto/  eventbus/
    storage/  blob/  index-vector/  index-text/  index-graph/  index-secondary/
    raft/  transport/  multiraft/  statemachine/  pd/
    txn/  kv/  models-client/  memory/  consolidation/  branching/  jobs/  cache/
    collections/  rules/  auth/  router/
    adapter-resp/  adapter-mcp/  adapter-http/  adapter-grpc/
    server/                     composition root, CLI
    sdk-ts/
  web/                          React + shadcn/ui dashboard
  python/
    model_service/
    sdk/
    evals/
    demo_agents/
  test/
    sim/                        deterministic simulator + scenarios
    maelstrom/
    chaos/
    bench/
    compat/                     redis client compatibility suites
  deploy/
    docker/  compose/  helm/  grafana/
  references/                   cloned reference repos (gitignored)
  .github/workflows/
```

---

## 24. Phased implementation plan

Twelve phases, about 36 weeks at ~25 h/week. Each phase ends with a gate you can demo. References in brackets (e.g., [R-etcd-raft]) point to section 28.

| Phase | Weeks | Theme | Core / optional |
|---|---|---|---|
| 0 | 1–2 | Foundations | Core |
| 1 | 3–5 | Single-node storage, KV, RESP3 | Core |
| 2 | 6–7 | HTTP API, dashboard v1, observability baseline | Core |
| 3 | 8–12 | Raft consensus + deterministic simulator | Core |
| 4 | 13–16 | Multi-Raft, placement driver, routing, transactions | Core |
| 5 | 17–20 | Model service, memory engine core, jobs, MCP server | Core |
| 6 | 21–23 | Advanced retrieval, packing, semantic cache, eval harness | Core |
| 7 | 24–26 | Log-native features: branches, conflicts, ASOF, provenance, change streams | Core (novelty) |
| 8 | 27–28 | Consolidation and memory lifecycle | Core (novelty) |
| 9 | 29–31 | Full-stack backend mode | Optional |
| 10 | 32–34 | Security hardening, multi-tenancy, semantic sharding, SDKs, embedded replicas | Core (security), optional (rest) |
| 11 | 35–36 | Performance, chaos, benchmarks, documentation, launch | Core |

**Minimum impressive cut** (if time is short): phases 0–5, plus branching, conflict detection and `ASOF` from phase 7, plus benchmarks from phase 11 — about 24 weeks.

---

### Phase 0 — Foundations (weeks 1–2)

**Goal**: a repository where every later phase can move fast and safely.

Tasks
- [ ] Create pnpm workspace, TypeScript project references, shared `tsconfig`, ESLint + boundaries rules, Prettier, Vitest, fast-check, `madge` cycle check.
- [ ] Python workspace with `uv`, ruff, mypy, pytest.
- [ ] `proto/` with `buf.yaml`, codegen for TS (protobuf-es) and Python; first schemas: `common.proto`, `commands.proto` (envelope only).
- [ ] `@mindlog/core`: `Result`, `MindlogError` + error-code table, ULID, HLC, order-preserving tuple key encoder (+ property tests), `Clock`/`Random` ports with real and fake implementations, config loader with schema validation, pino logger, metrics registry, OpenTelemetry setup.
- [ ] `@mindlog/eventbus` with typed events.
- [ ] GitHub Actions CI (section 22.5 steps 1–4), PR template, Conventional Commits check, changesets.
- [ ] `docs/` skeleton: copy this plan and the design doc; ADR template; write ADR-001 to ADR-004.
- [ ] `CLAUDE.md` (Appendix D) and `references/` setup script (Appendix C).

Deliverables: green CI on an empty-but-structured repo; key encoder library with property tests.
Exit gate: `pnpm test` and `pnpm lint` pass; boundary rules block an intentional illegal import; key-encoding order property holds for 100k random tuples.
References: [R-fdb-tuple], [R-cockroach-encoding].

---

### Phase 1 — Single-node storage, KV and RESP3 (weeks 3–5)

**Goal**: a single-node Redis-compatible server with durable storage.

Tasks
- [ ] `@mindlog/storage`: `KvStore` port, LevelDB adapter, `WriteBatch`, snapshots, MVCC read/write by version, tombstones, GC by threshold, in-memory fake store for tests.
- [ ] `@mindlog/statemachine` (single-node mode): command envelope, deterministic `apply`, idempotency table, `appliedIndex` persistence; a local "log" that assigns increasing indexes (replaced by Raft in phase 3 behind the same `Proposer` port).
- [ ] `@mindlog/kv`: strings, hashes, lists, sets, sorted sets, JSON (path subset), TTL (lazy + expiry job via proposals), `SCAN` cursors, `MULTI/EXEC/WATCH`.
- [ ] `@mindlog/adapter-resp`: incremental RESP2/RESP3 parser (zero-copy, handles partial frames), serializer, pipelining, `HELLO`, `AUTH` (single static user for now), command table + `COMMAND DOCS`, output buffer limits.
- [ ] Graceful shutdown (stop accepting, drain, flush, close).
- [ ] Fuzz the RESP parser; compatibility tests with ioredis and redis-py; run `redis-benchmark`.

Deliverables: `mindlog-server --single-node` works with `redis-cli`.
Exit gate: compatibility subset passes; `redis-benchmark -t set,get,incr,lpush,hset,zadd` completes; kill -9 and restart loses no acknowledged write (fsync on).
References: [R-resp3-spec], [R-valkey] (`src/t_*.c` for command semantics), [R-node-redis], [R-redis] (test suite), [R-classic-level].

---

### Phase 2 — HTTP API, dashboard v1, observability baseline (weeks 6–7)

**Goal**: make the system visible and operable early.

Tasks
- [ ] `@mindlog/adapter-http`: Fastify, `/health`, `/ready`, `/metrics`, `/api/kv/*` (scan, get, set, delete, TTL), RFC 9457 errors, OpenAPI generation, admin auth (superuser bootstrap via CLI).
- [ ] `web/` React + shadcn/ui dashboard (ADR-0023): login, Overview, Data browser (typed editors), Console (RESP over WebSocket proxy), Settings (read-only).
- [ ] Serve dashboard at `/_/` from the server; embed in the single binary build.
- [ ] Metrics for RESP/HTTP; tracing spans; Grafana dashboard JSON in `deploy/grafana/`.
- [ ] Docker images and `docker-compose.yml` (`dev` profile) including the (empty) model service placeholder.

Deliverables: open `localhost:8090/_/`, browse and edit keys created with `redis-cli`.
Exit gate: dashboard edit → visible in `redis-cli` and vice versa; Prometheus scrapes metrics; a trace shows RESP → apply → storage.
References: [R-pocketbase] (`ui/`, `apis/`), [R-fastify].

---

### Phase 3 — Raft consensus and deterministic simulation (weeks 8–12)

**Goal**: a correct, tested Raft for a single range across 3–5 nodes.

Tasks
- [ ] `@mindlog/raft` pure state machine: roles, terms, election with PreVote, CheckQuorum, AppendEntries with fast backtracking, commit rule, `Ready` struct, proposals, ReadIndex, leader lease, snapshots (create/install), log compaction, learners, single-server membership changes, leadership transfer, flow control.
- [ ] Raft log store on a dedicated LevelDB instance with group commit and CRC32C.
- [ ] `@mindlog/transport`: gRPC streaming transport (mTLS ready), message batching, snapshot chunk streaming.
- [ ] Replace the single-node proposer with Raft behind the same `Proposer` port; follower forwarding or `NotLeader` hints.
- [ ] Read paths: linearizable (ReadIndex), lease, follower bounded-staleness.
- [ ] `test/sim`: deterministic simulator with SimNetwork, SimDisk, SimClock, SimRandom; scenario DSL; invariant checker; seed replay.
- [ ] Maelstrom adapter (`test/maelstrom`): a small binary that speaks Maelstrom's JSON protocol over stdin/stdout and wraps the Raft + KV state machine; run `lin-kv` with partitions.
- [ ] Chaos compose profile: 3 nodes, kill/partition scripts.
- [ ] Write ADR-005 (separate log store), ADR-006 (single-server membership changes first), ADR-007 (lease reads and clock assumptions).

Deliverables: 3-node cluster; kill the leader during `redis-benchmark`; writes resume.
Exit gate: 10,000 simulator seeds with random faults pass all invariants; Maelstrom `lin-kv` reports valid under partitions; failover < 3 s measured.
References: [R-raft-paper], [R-raft-thesis], [R-mit-6.5840], [R-etcd-raft], [R-hashicorp-raft], [R-maelstrom], [R-fdb-sim], [R-piscina].

---

### Phase 4 — Multi-Raft, placement driver, routing, transactions (weeks 13–16)

**Goal**: many ranges, automatic splitting and rebalancing, correct cross-range writes.

Tasks
- [ ] `@mindlog/multiraft`: Store with many replicas, range descriptors with epochs, coalesced heartbeats, quiescence, batched Ready processing, split (by size/load) and merge execution.
- [ ] `@mindlog/pd`: Raft-replicated metadata, range directory, id allocation, TSO, store heartbeats, schedulers (replica balance, leader balance, hot split, cold merge, repair, drain), operator steps, placement rules (zones, tenant pinning, scope placement).
- [ ] `@mindlog/router`: range cache, retries on `NotLeader`/`RangeMoved`, multi-key fan-out.
- [ ] HLC propagation on all RPCs; clock offset fencing.
- [ ] `@mindlog/txn`: single-range atomic batches; Percolator prewrite/commit/rollback with TSO; lock resolution; feature flag.
- [ ] Dashboard Cluster page: nodes, ranges, leaders, operators, drain/transfer/split actions.
- [ ] Simulator scenarios with splits during partitions, leader transfers under load, node add/remove.
- [ ] ADR-009 (range size and split policy), ADR-010 (PD as separate Raft group + TSO).

Deliverables: load 5 GB of keys; ranges split; add a 4th node; replicas rebalance automatically.
Exit gate: simulator with splits/merges + faults passes; Maelstrom `txn-list-append` (or a custom bank-transfer invariant test) passes for cross-range transactions; adding a node rebalances within 10 minutes.
References: [R-tikv], [R-tikv-pd], [R-cockroach] (design doc, range and lease docs), [R-percolator], [R-hlc-paper].

---

### Phase 5 — Model service, memory engine core, jobs, MCP (weeks 17–20)

**Goal**: agents can remember and recall over MCP, fully offline.

Tasks
- [ ] `python/model_service`: gRPC server, micro-batcher, embeddings, GLiNER, NLI, reranker, llama-cpp extraction with JSON grammar, health, admission control, Dockerfile with models pre-downloaded for offline use, `MODELS.md` with licenses.
- [ ] `@mindlog/models-client`: ports + gRPC adapter + circuit breaker + fakes.
- [ ] `@mindlog/index-vector`, `index-text`, `index-graph` (adjacency + 1–2 hop walk; PPR comes in phase 6), all updated in apply.
- [ ] `@mindlog/jobs`: durable queue, leases, retries, dead letter, leader-only execution.
- [ ] `@mindlog/memory`: MemoryService facade, PipelineBuilder, ingestion stages 1–9 and 11–13 (conflicts in phase 7), recall stages 1, 3 (vector, keyword, entity), 4, 5, 7, 9 (simple packing), sync and async modes, degraded mode.
- [ ] Scopes, scope placement in PD, `MEM.*` RESP commands (add/search/get/forget/history), REST mirror.
- [ ] `@mindlog/adapter-mcp`: stdio + Streamable HTTP, tools `remember`, `recall`, `forget`, `history`, `graph_query`; resources; `recall-context` prompt; API-key auth.
- [ ] Dashboard: Memory explorer, Knowledge graph (basic), Recall playground (basic).
- [ ] `python/demo_agents`: a LangGraph or plain-Python agent using MCP.

Deliverables: Claude Desktop (or any MCP client) remembers a preference in session 1 and uses it in session 2; all with networking disabled.
Exit gate: offline run passes (container network disabled except localhost); recall p95 < 150 ms at 10K memories; degraded mode verified by stopping the model service.
References: [R-mem0], [R-cognee], [R-mcp-ts-sdk], [R-mcp-spec], [R-gliner], [R-sentence-transformers], [R-llama-cpp-python], [R-hnswlib-node], [R-qdrant], [R-letta], [R-redis-agent-memory].

---

### Phase 6 — Advanced retrieval, packing, semantic cache, eval harness (weeks 21–23)

**Goal**: measurably better recall at lower token cost.

Tasks
- [ ] Personalized PageRank retriever in a worker thread with node caps.
- [ ] Theme retrieval (theme memories come in phase 8; stub with entity-community summaries computed on demand for now) and query-level routing (specific vs broad).
- [ ] RRF fusion with per-retriever weights; final scoring formula; MMR diversification; cross-encoder rerank stage.
- [ ] Token-budget packing with grouping and compression fallback; `MEM.PACK`; MCP `recall` returns packed context.
- [ ] `@mindlog/cache`: semantic cache with dependency tracking and change-stream invalidation; `CACHE.*`, MCP `cache_lookup`/`cache_store`.
- [ ] `python/evals`: LongMemEval and LoCoMo runners, retrieval ablations, packing curves, cache metrics; baselines (Mem0 OSS, Cognee, Redis Agent Memory Server, plain RAG); results to `docs/evals/`.
- [ ] Dashboard Recall playground: per-retriever results, scores, packing visualization.
- [ ] ADR-011 (fusion and scoring), ADR-012 (cache invalidation design).

Deliverables: eval report with ablation table.
Exit gate: hybrid + PPR beats vector-only on LongMemEval in your harness; cache false-positive rate < 2% on the eval set at the chosen threshold.
References: [R-hipporag], [R-lightrag], [R-graphrag], [R-gptcache], [R-generative-agents], [R-longmemeval], [R-locomo], [R-mem0-benchmarks].

---

### Phase 7 — Log-native features (weeks 24–26)

**Goal**: the features that make Mindlog unique.

Tasks
- [ ] Conflict detection stage (13.2), conflict records, policies, `MEM.CONFLICTS`/`MEM.RESOLVE`, MCP tools; labelled contradiction set and threshold tuning.
- [ ] `@mindlog/branching`: branch metadata, overlay reads, branch-local indexes, merge planner with CRDT field rules and conflict checks, `MEM.BRANCH/MERGE/DROP/DIFF`, GC pinning.
- [ ] `ASOF` (index and time), index-time table, `VALID_AT` bitemporal filter.
- [ ] Provenance, trust policy, quarantine, taint cascade forget.
- [ ] Change streams: `MEM.WATCH`, MCP resource subscriptions, SSE, resumable cursors.
- [ ] Dashboard: Time travel, Branches (diff/merge), Conflicts inbox, Live feed.
- [ ] Simulator invariants for branch isolation and merge determinism; property tests for CRDT merge commutativity and idempotence.
- [ ] ADR-013 (branch overlay vs copy), ADR-015 (conflict policy defaults).

Deliverables: scripted multi-agent demo: two agents write contradicting facts → conflict raised → human resolves in dashboard; an agent tries a plan on a branch and merges; time-travel shows the state before the plan.
Exit gate: demo runs end to end from a script; conflict F1 reported; branch tests pass 10,000 sim seeds.
References: [R-dolt], [R-neon], [R-automerge], [R-graphiti], [R-crdt-paper], [R-nli-models], [R-letta] (memory worktrees and conflict repair), [R-cognee] (`tasks/graph/detect_contradictions.py`).

---

### Phase 8 — Consolidation and memory lifecycle (weeks 27–28)

**Goal**: memory that improves and forgets over time.

Tasks
- [ ] `@mindlog/consolidation`: scheduler, per-tenant budgets, checkpointed workers.
- [ ] SleepTimeConsolidator on branches with auto-reject on excessive conflicts.
- [ ] EvolutionWorker (A-MEM), Deduplicator, ThemeBuilder (Louvain/Leiden communities + summaries), EntitySummarizer.
- [ ] Forgetting curve (strength updates from recall stats), ForgettingWorker, cold tier on blob store, `INCLUDE_COLD`.
- [ ] Export/import `.mcube`, COGX import, tool-trace memories.
- [ ] ReembedWorker and index generations.
- [ ] Dashboard: Jobs page, memory version history view, cold-tier indicators.

Deliverables: a 30-day simulated usage run where memory count stays bounded and old-but-important facts are still recalled.
Exit gate: forgetting eval beats LRU eviction; sleep-time consolidation improves LongMemEval score or reduces tokens at equal score (report either way).
References: [R-letta-sleeptime], [R-a-mem], [R-memorybank], [R-memos], [R-cognee] (COGX docs), [R-leiden].

---

### Phase 9 — Full-stack backend mode (weeks 29–31, optional)

**Goal**: build a real app on Mindlog alone.

Tasks
- [ ] `@mindlog/rules`: lexer, parser, type checker, planner, evaluator; grammar fuzzer; planner-equivalence property tests.
- [ ] `@mindlog/collections`: schemas, field types, validation, modifiers, relations + expand, unique indexes (2PC across ranges), migrations.
- [ ] Auth: password (argon2id), OTP, OAuth2 (PKCE), JWT + refresh, API keys, delegated agent tokens.
- [ ] Files: BlobStore local + S3 (MinIO), protected files, thumbnails, orphan janitor.
- [ ] Realtime SSE with per-subscriber rule filtering; view collections with incremental maintenance; hooks in worker sandbox; scheduled jobs.
- [ ] REST API (PocketBase-shaped paths); TS SDK collections client.
- [ ] Dashboard Collections page with rule editor and autocomplete.
- [ ] Example app (`examples/todo-app`) using only Mindlog, plus an agent that reads the user's todos through rules.

Deliverables: todo app with signup/login, per-user data, file attachments, realtime updates, and an assistant agent.
Exit gate: authorization matrix tests pass (every rule slot × role × ownership case); app works end to end.
References: [R-pocketbase] (collections, rules, auth, files, realtime docs and code), [R-pocketbase-js-sdk], [R-supabase-realtime] (optional comparison), [R-materialize] (incremental views concept).

---

### Phase 10 — Security hardening, multi-tenancy, scale features, SDKs (weeks 32–34)

**Goal**: enterprise-grade isolation and the remaining scale features.

Tasks
- [ ] RBAC roles and policy evaluation; tenant admin; quotas and rate limits; audit log; dashboard Logs & audit.
- [ ] mTLS everywhere in `production` profile; cert rotation; secrets handling; encryption at rest (ADR-014).
- [ ] PII redaction stage; tenant data export and deletion workflow.
- [ ] Semantic split for large scopes (8.5) with measurement.
- [ ] SDKs: TypeScript and Python; embedded replicas with offline write queue; LangGraph store/checkpointer and CrewAI memory adapters.
- [ ] Cross-tenant fuzzing; dependency audit; SBOM.

Deliverables: two tenants on one cluster with quotas; an agent using an embedded replica keeps reading while the network is cut.
Exit gate: cross-tenant access fuzzing finds nothing; semantic-split recall@10 within 5% of single-range baseline (or documented gap).
References: [R-turso-embedded], [R-opa] (policy model inspiration), [R-tikv-pd] (placement rules).

---

### Phase 11 — Performance, chaos, benchmarks, documentation, launch (weeks 35–36)

**Goal**: credible numbers and a polished public project.

Tasks
- [ ] Profile and optimize hot paths (RESP parse, key encoding, apply batching, recall stages); flame graphs before/after.
- [ ] Full benchmark suite (section 20.4) on 1 and 3 nodes; failover under load; publish results with hardware details.
- [ ] Chaos week: scripted partitions, crashes, disk-full, clock skew, model-service outages; fix findings.
- [ ] Backup/restore verification job; runbooks complete.
- [ ] Docs site: getting started, architecture, RESP compatibility table, MCP tool reference, REST/OpenAPI, SDK guides, evals, ADR index.
- [ ] Demo video (5 minutes): Redis compatibility → failover → agent memory over MCP → conflict + branch + time travel → dashboard.
- [ ] Blog post / design write-up with trade-offs and measured results.
- [ ] v1.0.0 release: images, binaries, SDK packages.

Exit gate: all SLO targets measured and published (met or explained); zero acknowledged-write loss across chaos runs; docs and demo public.
References: [R-jepsen-analyses], [R-redis-benchmark], [R-memtier], [R-dragonfly].

---

## 25. Architecture decision records to write

| ADR | Decision |
|---|---|
| 001 | TypeScript server + Python model sidecar |
| 002 | Hexagonal architecture, package-per-module, boundary enforcement |
| 003 | The Raft log is the single source of truth; deterministic apply |
| 004 | Protobuf for commands and internal RPCs |
| 005 | Separate LevelDB instance for Raft logs; state store without fsync |
| 006 | Single-server membership changes before joint consensus |
| 007 | Leader leases and clock-offset assumptions |
| 008 | HNSW determinism trade-off and filtering approach |
| 009 | Range size, split and merge policy |
| 010 | Placement driver as its own Raft group with a TSO |
| 011 | Retrieval fusion (RRF) and scoring formula |
| 012 | Semantic cache dependency-tracking invalidation |
| 013 | Branches as overlays at a fork index, not copies |
| 014 | Encryption at rest: values encrypted, keys in plaintext |
| 015 | Conflict policy defaults (quarantine new) |
| 016 | Model calls only on the leader; results embedded in commands |
| 017 | Durable jobs stored in the scope's range |
| 018 | Rule language compatible with PocketBase filter syntax |
| 019 | Change-stream cursors as (rangeId, index) |
| 020 | Offline-first: no network dependency by default |
| 021 | KV writes replicated as command argv, re-executed deterministically in apply |
| 022 | Collection generations for O(1) delete; dead generations removed by replicated GC |
| 023 | Dashboard as a React + shadcn/ui static app |
| 024 | HTTP adapter on Fastify; superusers in the system tenant with bearer tokens |
| 025 | Raft transport on Connect (gRPC over HTTP/2) |
| 026 | Raft log format v2, snapshots and data-directory format markers |
| 027 | MVCC versions are per-range HLC timestamps (store format 3) |
| 028 | Range-local system state, PD-allocated replica ids, the multi-range store |
| 029 | Request routing, forwarding and range epochs (`CROSS_RANGE`) |
| 030 | Cross-range transactions with Percolator |

---

## 26. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Writing Raft from scratch takes longer than planned | High | High | Pure state machine design, port etcd's test scenarios, simulator from day one; phase 3 has buffer; cut joint consensus and transactions first |
| Node.js event-loop stalls under load | Medium | High | Worker threads for CPU work, event-loop lag metrics, load shedding |
| LevelDB binding limitations (no checkpoints, compaction stalls) | Medium | Medium | `KvStore` port allows swapping to RocksDB bindings or LMDB; ADR documents fallback |
| HNSW non-determinism across replicas | Medium | Low | Documented trade-off (ADR-008); record sets identical; optional deterministic fork later |
| Local models too weak for extraction quality | Medium | Medium | Measure with evals; allow optional remote extractor per tenant; fall back to episodic storage |
| Scope creep (too many features) | High | High | Phase gates, minimum impressive cut, optional phases clearly marked |
| Model service resource usage on a laptop | Medium | Medium | Small models, lazy loading, disable LLM extraction in dev profile |
| Licensing issues copying reference code | Low | Medium | Study, do not copy; if copying, keep notices (Apache-2.0/MIT); record in `THIRD_PARTY_NOTICES` |
| Benchmarks look weak vs Redis | High | Low | Frame correctly: durability and features vs raw speed; publish honest numbers and trade-offs |
| Burnout over 36 weeks | Medium | High | Demoable gates every 2–5 weeks; publish progress; allow the minimum cut |

---

## 27. Interview and resume framing

### 27.1 Resume lines (fill in measured numbers)

- Built **Mindlog**, a Redis-compatible distributed database in TypeScript with a from-scratch **Multi-Raft** implementation (PreVote, ReadIndex, leases, snapshots); verified linearizable with **Jepsen Maelstrom** and a deterministic simulator over N seeds; X ops/s at p99 Y ms on 3 nodes; leader failover < Z s.
- Designed an **AI agent memory engine** with MCP access: hybrid vector + BM25 + Personalized PageRank retrieval scoring N on LongMemEval, fully offline via a Python inference sidecar.
- Introduced **branchable agent memory**, **semantic conflict detection at commit time** and **point-in-time recall** built on the replicated log; memory-aware semantic cache cut LLM tokens by P%.
- Added a PocketBase-style backend layer: collections, a rule language with parser/planner, user auth, files and realtime.

### 27.2 Questions to be ready for

Why Raft over Paxos · How PreVote prevents disruption · Why lease reads need bounded clock drift · What happens when a follower is behind the compacted log · How you keep replicas deterministic when models are non-deterministic · How a split happens without unavailability · Percolator's commit point · How branch merges stay deterministic · Precision/recall of conflict detection and the cost of false positives · Why RRF instead of score normalization · How the semantic cache avoids serving stale answers · Node.js limits and how you worked around them · What you would change for 100× scale.

---

## 28. Reference open-source projects — study and analysis guide

These are the projects whose architecture and features Mindlog draws on. For each one: what to read, what to extract, and where it lands in Mindlog. Read a reference **at the start of the phase that uses it**, not all at once.

### 28.1 How to analyse a reference (do this for every R-id you use)

1. Clone shallow into `references/<id>` (Appendix C script).
2. Read the README and architecture docs first, then only the folders listed below.
3. Write `docs/references/<id>.md` using this template:

```markdown
# <Project> — analysis
- Version/commit studied:
- License: (check LICENSE; note if copying is allowed and what notice is required)
## What problem it solves
## Architecture in 5 bullets
## Key data structures (with file paths)
## Key algorithms (with file paths and a short pseudocode)
## Invariants and failure handling
## Tests worth porting as scenarios
## What Mindlog adopts / changes / rejects, and why
## Open questions
```

4. Turn "tests worth porting" into test cases in the matching package.
5. Link the analysis from the relevant ADR.

Prompt to give Claude Code for an analysis:

> Read `references/<id>/<paths>` and `docs/PLAN.md` section <n>. Fill `docs/references/<id>.md` using the template in PLAN.md 28.1. Cite file paths and function names for every claim. Do not write implementation code yet.

**Licensing rule**: study freely; do not paste code. If a snippet is genuinely needed, check the license (most here are Apache-2.0 or MIT), keep the notice, and record it in `THIRD_PARTY_NOTICES.md`. Redis 8 source is available under Redis's tri-license (including AGPLv3); prefer reading **Valkey** (BSD-3-Clause) for implementation details of command semantics. Materialize uses the Business Source License — use it for concepts only.

### 28.2 Storage, encoding and Redis compatibility

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-resp3-spec | [redis/redis-specifications](https://github.com/redis/redis-specifications) | `protocol/RESP3.md` | Every RESP3 type, `HELLO` negotiation, attribute and push types | `adapter-resp`, phase 1 |
| R-node-redis | [redis/node-redis](https://github.com/redis/node-redis) | Its RESP decoder/encoder in the client package | Incremental parsing of partial frames in TypeScript, buffer handling | `adapter-resp`, phase 1 |
| R-valkey | [valkey-io/valkey](https://github.com/valkey-io/valkey) | `src/t_string.c`, `t_hash.c`, `t_list.c`, `t_set.c`, `t_zset.c`, `t_stream.c`, `networking.c`, `expire.c` | Exact command semantics, edge cases, error messages, expiry design | `kv`, `adapter-resp`, phase 1 |
| R-redis | [redis/redis](https://github.com/redis/redis) | Command docs JSON (`src/commands/*.json`), test suite `tests/unit/` | Command arity/flags for `COMMAND DOCS`; test cases to port as compatibility tests | `adapter-resp`, `test/compat`, phase 1 |
| R-dragonfly | [dragonflydb/dragonfly](https://github.com/dragonflydb/dragonfly) | Architecture docs (`docs/`) | How a modern Redis-compatible server structures compatibility and transactions; comparison for the write-up | Docs, phase 11 |
| R-classic-level | [Level/classic-level](https://github.com/Level/classic-level) | README, API docs, tests | Batches, iterators, snapshots, `sync` semantics, error behaviour | `storage`, phase 1 |
| R-fdb-tuple | [FoundationDB data modeling and tuple layer](https://apple.github.io/foundationdb/data-modeling.html) | Tuple layer section | Order-preserving tuple encoding | `core` key encoder, phase 0 |
| R-cockroach-encoding | [cockroachdb/cockroach](https://github.com/cockroachdb/cockroach) | `pkg/util/encoding/` | Order-preserving encodings for ints, bytes, descending order | `core`, phase 0 |

### 28.3 Consensus, replication and distributed systems

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-raft-paper | [Raft paper](https://raft.github.io/raft.pdf) | Whole paper, Figure 2 above all | Exact rules for RPCs and state; your implementation checklist | `raft`, phase 3 |
| R-raft-thesis | [Ongaro's dissertation](https://github.com/ongardie/dissertation) | Chapters on membership changes, log compaction, client interaction, leader leases, PreVote | Single-server membership changes, ReadIndex, leases, PreVote | `raft`, phase 3 |
| R-mit-6.5840 | [MIT 6.5840 Distributed Systems](https://pdos.csail.mit.edu/6.824/) | Raft lab specs and test descriptions, KV lab | Test scenarios (figure-8, unreliable network, snapshots) to port into the simulator | `raft`, `test/sim`, phase 3 |
| R-etcd-raft | [etcd-io/raft](https://github.com/etcd-io/raft) | `raft.go`, `log.go`, `log_unstable.go`, `read_only.go`, `tracker/`, `confchange/`, `rawnode.go`, `testdata/` | Pure state-machine design with `Ready`; flow control; ReadIndex; data-driven test scenarios to port | `raft`, phase 3 |
| R-hashicorp-raft | [hashicorp/raft](https://github.com/hashicorp/raft) | `raft.go`, `replication.go`, `snapshot.go`, `net_transport.go` | A contrasting design with I/O inside the library; snapshot streaming | `raft`, `transport`, phase 3 |
| R-maelstrom | [jepsen-io/maelstrom](https://github.com/jepsen-io/maelstrom) | `doc/` (protocol, workloads, Raft chapter) | Node protocol over stdin/stdout, `lin-kv` and `txn-list-append` workloads | `test/maelstrom`, phases 3–4 |
| R-fdb-sim | [FoundationDB paper](https://www.foundationdb.org/files/fdb-paper.pdf) and [TigerBeetle](https://github.com/tigerbeetle/tigerbeetle) (its simulator docs) | Simulation testing sections | Deterministic simulation design: injected I/O, seeds, fault schedules, invariant checks | `test/sim`, phase 3 |
| R-tikv | [tikv/tikv](https://github.com/tikv/tikv) and [TiKV deep dive](https://tikv.org/deep-dive/) | Multi-Raft, region split, Percolator, coprocessor overview | Region (range) lifecycle, split/merge, store/peer model, lock resolution | `multiraft`, `txn`, phase 4 |
| R-tikv-pd | [tikv/pd](https://github.com/tikv/pd) | Schedulers, operators, TSO, placement rules | Scheduling as operator steps; TSO batching; placement rules | `pd`, phases 4 and 10 |
| R-cockroach | [cockroachdb/cockroach](https://github.com/cockroachdb/cockroach) | `docs/design.md`, `docs/RFCS/` on range leases, coalesced heartbeats, quiescence, follower reads | Leases, quiescence, coalesced heartbeats, follower reads, range descriptors with epochs | `multiraft`, `router`, phase 4 |
| R-percolator | [Percolator paper](https://research.google/pubs/large-scale-incremental-processing-using-distributed-transactions-and-notifications/) | Transaction protocol section | Primary lock as commit point, prewrite/commit, lock cleanup | `txn`, phase 4 |
| R-hlc-paper | [Logical Physical Clocks (HLC)](https://cse.buffalo.edu/tech-reports/2014-04.pdf) | Algorithm section | HLC update rules and bounds | `core` HLC, phase 4 |
| R-jepsen-analyses | [Jepsen analyses](https://jepsen.io/analyses) | Analyses of etcd, CockroachDB, TiDB, Redis-Raft | Failure modes others hit; checklist for your chaos week | Phase 11 |

### 28.4 AI agent memory

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-mem0 | [mem0ai/mem0](https://github.com/mem0ai/mem0) | `mem0/memory/` (main memory class, prompts), `mem0/configs/`, vector store adapters | Add-only extraction prompts, user/session/agent scoping, entity linking, multi-signal retrieval, history tracking | `memory`, phase 5 |
| R-mem0-benchmarks | [mem0ai/memory-benchmarks](https://github.com/mem0ai/memory-benchmarks) | Runners and judge prompts | How to run LoCoMo/LongMemEval/BEAM fairly | `python/evals`, phase 6 |
| R-cognee | [topoteretes/cognee](https://github.com/topoteretes/cognee) | `cognee/` pipeline and task modules, `cognee-mcp/`, docs on remember/recall/improve/forget, ontology, COGX migration | Graph extraction pipeline, local GLiNER path, session distillation, MCP tool design, COGX import | `memory`, `consolidation`, `adapter-mcp`, phases 5 and 8 |
| R-graphiti | [getzep/graphiti](https://github.com/getzep/graphiti) | `graphiti_core/` (edges, temporal handling, search) | Bitemporal edges (valid time vs system time), edge invalidation instead of deletion | Memory record, `ASOF`, `VALID_AT`, phase 7 |
| R-letta | [letta-ai/letta-code](https://github.com/letta-ai/letta-code) (current source, TypeScript) and the `archive` branch of [letta-ai/letta](https://github.com/letta-ai/letta/tree/archive) (retired V1 server with memory blocks and sleep-time agents) | letta-code: `src/agent/memory-filesystem.ts`, `memory-git.ts`, `memory-worktree.ts`, `memory-conflict-repair.ts`, `memory-operation.ts`, `reflection-runs.ts`; archive: memory blocks and sleep-time agent services | Git-backed memory with isolated reflection worktrees, single-writer lease for background memory work, memory tiers | `memory`, `consolidation`, `branching`, phases 5, 7 and 8 |
| R-letta-sleeptime | [Sleep-time compute blog](https://www.letta.com/blog/sleep-time-compute) and [paper](https://arxiv.org/abs/2504.13171) | Whole post and method section | Trigger policy and what work to do during idle time | `SleepTimeConsolidator`, phase 8 |
| R-a-mem | [agiresearch/A-mem](https://github.com/agiresearch/A-mem) | Whole repo (small) | Note construction, link generation, memory evolution prompts | `LinkNotes`, `EvolutionWorker`, phases 5 and 8 |
| R-memorybank | [zhongwanjun/MemoryBank-SiliconFriend](https://github.com/zhongwanjun/MemoryBank-SiliconFriend) and [paper](https://arxiv.org/abs/2305.10250) | Memory updating section | Forgetting curve R = e^(−t/S), reinforcement on recall | Forgetting, eviction, phase 8 |
| R-memos | [MemTensor/MemOS](https://github.com/MemTensor/MemOS) | MemCube design, memory types (text, tool traces) | Portable memory units, tool-trace memory, scheduling ideas | Export/import, tool traces, phase 8 |
| R-redis-agent-memory | [redis-developer/agent-memory-server](https://github.com/redis-developer/agent-memory-server) | Server, memory types, MCP tools | Baseline feature set; working vs long-term memory API | Baseline comparison, phases 5–6 |
| R-generative-agents | [Generative Agents paper](https://arxiv.org/abs/2304.03442) and [code](https://github.com/joonspk-research/generative_agents) | Memory stream and retrieval section | Recency × importance × relevance scoring; reflection | Scoring, phase 6 |
| R-longmemeval | [LongMemEval](https://github.com/xiaowu0162/LongMemEval) | Dataset format, evaluation scripts | Eval protocol | `python/evals`, phase 6 |
| R-locomo | [LoCoMo](https://github.com/snap-research/locomo) | Dataset and QA categories | Eval protocol; synthetic dialogue design ideas | `python/evals`, phase 6 |

### 28.5 Retrieval, graphs and caching

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-hipporag | [OSU-NLP-Group/HippoRAG](https://github.com/OSU-NLP-Group/HippoRAG) | Retrieval code (PPR, seed selection, passage nodes) | Personalized PageRank over KG with query entities as seeds; recognition-memory filtering | PPR retriever, phase 6 |
| R-lightrag | [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG) | `lightrag/` (dual-level retrieval, incremental insert) | Entity-level vs theme-level retrieval; incremental graph update without rebuild | Theme retrieval, `ThemeBuilder`, phases 6 and 8 |
| R-graphrag | [microsoft/graphrag](https://github.com/microsoft/graphrag) | Indexing pipeline docs (community detection, community reports) | Leiden communities and community summaries for global questions | `ThemeBuilder`, phase 8 |
| R-leiden | [graphology](https://github.com/graphology/graphology) (Louvain in TS) and [leidenalg](https://github.com/vtraag/leidenalg) | Community detection APIs | Which algorithm to run where (TS worker vs Python service) | `ThemeBuilder`, phase 8 |
| R-hnswlib-node | [yoshoku/hnswlib-node](https://github.com/yoshoku/hnswlib-node) and [nmslib/hnswlib](https://github.com/nmslib/hnswlib) | API, filter support, persistence, `ALGO_PARAMS.md` | Parameters (M, ef), deletes, save/load, filtering capability of the pinned version | `index-vector`, phase 5 |
| R-qdrant | [qdrant/qdrant](https://github.com/qdrant/qdrant) | Docs on filtering during HNSW search, payload indexes | Filtered search design; payload index strategy | `index-vector`, phase 5 |
| R-gptcache | [zilliztech/GPTCache](https://github.com/zilliztech/GPTCache) | `gptcache/` (similarity evaluation, eviction) | Semantic cache structure, similarity thresholds, evaluation of false hits | `cache`, phase 6 |
| R-nli-models | [cross-encoder models on Hugging Face](https://huggingface.co/cross-encoder) | NLI and reranker model cards | Model choice, label order, expected accuracy and speed | Model service, phases 5 and 7 |
| R-gliner | [urchade/GLiNER](https://github.com/urchade/GLiNER) | README, inference API, model cards | Zero-shot NER with custom labels on CPU | Model service, phase 5 |
| R-sentence-transformers | [UKPLab/sentence-transformers](https://github.com/UKPLab/sentence-transformers) | Encoding and CrossEncoder APIs | Batching, normalization, query/passage prompts | Model service, phase 5 |
| R-llama-cpp-python | [abetlen/llama-cpp-python](https://github.com/abetlen/llama-cpp-python) | Server, grammar/JSON-schema constrained output | Deterministic JSON extraction on CPU | Model service, phase 5 |

### 28.6 Branching, CRDTs and time travel

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-dolt | [dolthub/dolt](https://github.com/dolthub/dolt) | Docs and blog posts on branches, merge, conflicts | Branch/merge/diff UX and conflict model for data | `branching`, phase 7 |
| R-neon | [neondatabase/neon](https://github.com/neondatabase/neon) | Architecture docs (branching via copy-on-write at an LSN) | Branch = pointer to a log position; storage reuse | `branching`, phase 7 |
| R-automerge | [automerge/automerge](https://github.com/automerge/automerge) | JavaScript package docs, merge semantics | OR-set, counters, LWW registers; how merges stay commutative | Merge planner, phase 7 |
| R-crdt-paper | [A comprehensive study of CRDTs](https://hal.inria.fr/inria-00555588) | Sections on OR-Set, PN-Counter, LWW-Register | Formal semantics for property tests | Merge planner tests, phase 7 |

### 28.7 Backend platform, realtime and SDKs

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-pocketbase | [pocketbase/pocketbase](https://github.com/pocketbase/pocketbase) and [docs](https://pocketbase.io/docs/) | `ui/` (dashboard), `apis/` (records, realtime, files, auth), `core/` (collections, fields, record rules), `tools/search` (filter parser/resolver); docs: collections, API rules and filters, authentication, files | Collections and field types, rule semantics and status codes, filter grammar, auth flows, realtime subscriptions, single-binary dashboard embedding (`ui/embed.go` with a `no_ui` build tag); the dashboard is a Vite app that talks to the server only through PocketBase's own JS SDK; hooks are middleware chains (`tools/hook`, handler calls `e.Next()`), tagged per collection | `collections`, `rules`, `auth`, `adapter-http`, `web`, phases 2 and 9 |
| R-pocketbase-js-sdk | [pocketbase/js-sdk](https://github.com/pocketbase/js-sdk) | Client services, realtime client | SDK ergonomics for collections and realtime | `sdk-ts`, phase 9 |
| R-supabase-realtime | [supabase/realtime](https://github.com/supabase/realtime) | Architecture docs | Change-data-capture to client subscriptions with authorization | Realtime design comparison, phase 9 |
| R-materialize | [MaterializeInc/materialize](https://github.com/MaterializeInc/materialize) (BSL; concepts only) | Docs on incremental view maintenance | Why views can be kept up to date from a change stream | View collections, phase 9 |
| R-turso-embedded | [Turso embedded replicas docs](https://docs.turso.tech/features/embedded-replicas/introduction) and [tursodatabase/libsql](https://github.com/tursodatabase/libsql) | Embedded replica sync design | Local replica + sync from remote; read-your-writes | SDK embedded replicas, phase 10 |
| R-opa | [open-policy-agent/opa](https://github.com/open-policy-agent/opa) | Policy model docs | Policy-as-data, decision logging | `auth` RBAC, phase 10 |

### 28.8 Protocols, frameworks and tooling

| ID | Project | Read | Extract | Used in |
|---|---|---|---|---|
| R-mcp-spec | [MCP specification](https://modelcontextprotocol.io/specification) | Tools, resources, prompts, transports (stdio, Streamable HTTP), authorization, changelog | Exact protocol behaviour; track the current revision and deprecations | `adapter-mcp`, phase 5 |
| R-mcp-ts-sdk | [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) | `packages/server`, `packages/middleware` (Fastify helper), `examples/` (bearer-auth, caching, server) | v2 split packages `@modelcontextprotocol/server` + `@modelcontextprotocol/fastify`, implementing spec revision 2026-07-28; Standard Schema (Zod v4) tool schemas; Host-header validation | `adapter-mcp`, phase 5 |
| R-fastify | [fastify/fastify](https://github.com/fastify/fastify) | Docs on schemas, hooks, plugins, SSE plugins | Typed routes, OpenAPI generation | `adapter-http`, phase 2 |
| R-piscina | [piscinajs/piscina](https://github.com/piscinajs/piscina) | README | Worker-thread pool with queues and limits | CPU offload, phases 3–6 |
| R-redis-benchmark | [redis-benchmark docs](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/benchmarks/) | Options | Benchmark methodology | Phase 11 |
| R-memtier | [RedisLabs/memtier_benchmark](https://github.com/RedisLabs/memtier_benchmark) | README | Mixed workloads, latency percentiles | Phase 11 |

### 28.9 Reading order by phase

| Phase | Read first | Then |
|---|---|---|
| 0 | R-fdb-tuple, R-cockroach-encoding | — |
| 1 | R-resp3-spec, R-valkey (command files), R-classic-level | R-node-redis, R-redis (tests) |
| 2 | R-pocketbase (`ui/`, `apis/`) | R-fastify |
| 3 | R-raft-paper, R-raft-thesis, R-etcd-raft | R-mit-6.5840, R-maelstrom, R-fdb-sim, R-hashicorp-raft |
| 4 | R-tikv deep dive, R-cockroach design doc | R-tikv-pd, R-percolator, R-hlc-paper |
| 5 | R-mem0, R-cognee, R-mcp-spec | R-mcp-ts-sdk, R-gliner, R-hnswlib-node, R-qdrant, R-letta, R-redis-agent-memory |
| 6 | R-hipporag, R-lightrag | R-gptcache, R-generative-agents, R-longmemeval, R-locomo, R-mem0-benchmarks |
| 7 | R-graphiti, R-dolt, R-neon | R-automerge, R-crdt-paper, R-nli-models |
| 8 | R-letta-sleeptime, R-a-mem, R-memorybank | R-graphrag, R-leiden, R-memos |
| 9 | R-pocketbase (`core/`, `tools/search`, docs) | R-pocketbase-js-sdk, R-supabase-realtime, R-materialize |
| 10 | R-turso-embedded, R-opa | R-tikv-pd placement rules |
| 11 | R-jepsen-analyses | R-redis-benchmark, R-memtier, R-dragonfly |

---

## Appendix A — Glossary

| Term | Meaning |
|---|---|
| Range | Contiguous key span replicated by one Raft group |
| Replica | One copy of a range on one node |
| PD | Placement driver: cluster metadata, TSO, scheduling |
| TSO | Timestamp oracle: strictly increasing timestamps for transactions |
| HLC | Hybrid logical clock |
| ReadIndex | Raft technique for linearizable reads without log writes |
| Lease read | Leader serves reads without a round trip while its lease is valid |
| Scope | `tenant/user/agent/session` namespace for memory |
| Branch | Copy-on-write overlay of a scope's memory at a fork index |
| Quarantine | Trust state that excludes a memory from default recall |
| PPR | Personalized PageRank |
| RRF | Reciprocal Rank Fusion |
| MMR | Maximal Marginal Relevance |
| NLI | Natural Language Inference (entail / neutral / contradict) |
| Retention R / strength S | Forgetting-curve quantities, R = e^(−t/S) |
| Memory cube | Portable `.mcube` export of a scope |
| Degraded mode | Operation while the model service is unavailable |

## Appendix B — Configuration file reference (`mindlog.yaml`)

```yaml
node:
  id: node-1
  raftId: 1                     # non-zero, never reused (ADR-0006)
  dataDir: ./data
  zone: local-a
cluster:
  peers:                        # phase 3 static bootstrap until PD (phase 4)
    - { id: 1, address: 127.0.0.1:7000 }
  join: false                   # true: start with no configuration and wait to be added as a learner
  pdEndpoints: ["127.0.0.1:7100"]
  joinToken: ${MINDLOG_JOIN_TOKEN}
  maxClockOffsetMs: 500
listen:
  resp: { host: 0.0.0.0, port: 6379, tls: false }
  http: { host: 0.0.0.0, port: 8090 }
  grpc: { host: 0.0.0.0, port: 9090 }
  internal: { host: 0.0.0.0, port: 7000, mtls: { ca: ./certs/ca.pem, cert: ./certs/node.pem, key: ./certs/node-key.pem } }
  mcp: { http: { port: 8765 }, stdio: true }
raft:
  tickMs: 100
  electionTicks: [10, 20]
  heartbeatTicks: 1
  leaseTicks: 9                 # < electionTicks[0] (ADR-0007)
  maxInflightMsgs: 256
  maxInflightBytes: 16777216
  maxEntryBatchBytes: 1048576
  snapshotEntries: 10000
  trailingEntries: 1000
  snapshotChunkBytes: 1048576
ranges:
  maxBytes: 67108864
  mergeBelowBytes: 16777216
storage:
  mvccRetention: { kv: 7d, memory: 30d }
  coldTier: { enabled: true, blob: default }
blob:
  default: { type: local, path: ./blobs }      # or { type: s3, endpoint: http://minio:9000, bucket: mindlog }
models:
  endpoint: 127.0.0.1:50051
  timeoutsMs: { embed: 2000, ner: 3000, nli: 3000, rerank: 3000, extract: 20000 }
  circuitBreaker: { failures: 5, resetMs: 30000 }
memory:
  defaults:
    extraction: on
    conflictPolicy: quarantine_new
    conflictThreshold: 0.8
    recall: { k: 50, rrfK: 60, weights: { vector: 1.0, keyword: 1.0, entity: 1.0, ppr: 1.2, theme: 1.5 } }
    scoring: { relevance: 0.6, recency: 0.15, importance: 0.15, retention: 0.1 }
    packing: { defaultBudget: 2000, mmrLambda: 0.7 }
    cache: { threshold: 0.92, ttl: 1d }
    consolidation: { sleepIdleMinutes: 10, minNewMemories: 20, modelSecondsPerHour: 600 }
auth:
  superuserBootstrap: ${MINDLOG_ADMIN_PASSWORD}
  jwt: { accessTtl: 15m, refreshTtl: 30d }
  oauth2: { google: { clientId: "", clientSecret: "" } }
observability:
  logLevel: info
  tracing: { endpoint: http://jaeger:4318, sampleRatio: 0.05 }
features:
  fullStackMode: false
  crossRangeTxn: false
  semanticSplit: false
profile: dev            # dev | production (production forces TLS, auth, mTLS)
```

## Appendix C — Reference clone script (`scripts/clone-references.sh`)

```bash
#!/usr/bin/env bash
# Usage: scripts/clone-references.sh <phase>   (clones only that phase's references)
set -euo pipefail
mkdir -p references && cd references
clone() { [ -d "$1" ] || git clone --depth 1 "$2" "$1"; }
case "${1:-all}" in
  0|all) clone cockroach https://github.com/cockroachdb/cockroach ;;&
  1|all) clone redis-specifications https://github.com/redis/redis-specifications
         clone valkey https://github.com/valkey-io/valkey
         clone redis https://github.com/redis/redis
         clone node-redis https://github.com/redis/node-redis
         clone classic-level https://github.com/Level/classic-level ;;&
  2|9|all) clone pocketbase https://github.com/pocketbase/pocketbase
         clone pocketbase-js-sdk https://github.com/pocketbase/js-sdk ;;&
  3|all) clone etcd-raft https://github.com/etcd-io/raft
         clone hashicorp-raft https://github.com/hashicorp/raft
         clone maelstrom https://github.com/jepsen-io/maelstrom
         clone dissertation https://github.com/ongardie/dissertation ;;&
  4|10|all) clone tikv https://github.com/tikv/tikv
         clone pd https://github.com/tikv/pd ;;&
  5|all) clone mem0 https://github.com/mem0ai/mem0
         clone cognee https://github.com/topoteretes/cognee
         clone letta-code https://github.com/letta-ai/letta-code
         clone mcp-typescript-sdk https://github.com/modelcontextprotocol/typescript-sdk
         clone agent-memory-server https://github.com/redis-developer/agent-memory-server
         clone GLiNER https://github.com/urchade/GLiNER
         clone hnswlib-node https://github.com/yoshoku/hnswlib-node ;;&
  6|all) clone HippoRAG https://github.com/OSU-NLP-Group/HippoRAG
         clone LightRAG https://github.com/HKUDS/LightRAG
         clone GPTCache https://github.com/zilliztech/GPTCache
         clone memory-benchmarks https://github.com/mem0ai/memory-benchmarks
         clone LongMemEval https://github.com/xiaowu0162/LongMemEval
         clone locomo https://github.com/snap-research/locomo ;;&
  7|all) clone graphiti https://github.com/getzep/graphiti
         clone automerge https://github.com/automerge/automerge ;;&
  8|all) clone A-mem https://github.com/agiresearch/A-mem
         clone MemOS https://github.com/MemTensor/MemOS
         clone graphrag https://github.com/microsoft/graphrag
         clone MemoryBank https://github.com/zhongwanjun/MemoryBank-SiliconFriend ;;&
  *) : ;;
esac
echo "References ready in ./references (gitignored)."
```

Large repos (cockroach, tikv, valkey, redis) are big even shallow; for those, a sparse checkout of only the listed folders saves disk (`git clone --depth 1 --filter=blob:none --sparse <url>` then `git sparse-checkout set <paths>`).

## Appendix D — `CLAUDE.md` template

The full, maintained version is `CLAUDE.md` at the repository root (it also summarises `docs/references/ANALYSIS.md`). The minimal template below is kept for reference.

```markdown
# Mindlog

Source of truth: docs/PLAN.md (what and in which order) and docs/adr/ (why).
Current phase: 0  ← update when a phase gate passes.

## Architecture rules (enforced by lint)
- Hexagonal: domain packages import only ports; adapters are wired in packages/server/src/bootstrap.
- Import other modules only via @mindlog/<pkg>; never deep paths. No cycles.
- State machine apply() is deterministic: no Date.now, Math.random, network or model calls.
- Model calls happen on the leader before proposing; results go into the command.
- bigint for log indexes, terms and HLC.
- Expected failures return Result<T, E>; use MindlogErrorCode.

## Working rules for Claude Code
- Before coding a module, read its PLAN.md section and its references' analysis in docs/references/.
- Study code in references/ (read-only). Never copy code from it; write our own.
- Every change ships with tests (unit + property where relevant). Run `pnpm test` and `pnpm lint` before finishing.
- New significant decision → write an ADR in docs/adr/.
- Explain non-obvious designs in the package README (purpose, API, invariants).
- Keep the event loop free: CPU work > 1 ms goes to the worker pool.

## Reference map for the current phase
(copy the phase's rows from PLAN.md section 28.9)

## Commands
- pnpm install · pnpm build · pnpm test · pnpm lint · pnpm sim --seeds 1000
- uv sync (python/) · uv run pytest
- docker compose --profile dev up
```

## Appendix E — Definition of done (every task)

- [ ] Code follows module boundaries; no new lint or type errors.
- [ ] Unit tests (and property tests where the logic has algebraic properties) added and passing.
- [ ] Simulator scenarios updated if the change touches replication, storage, branching or apply.
- [ ] Metrics and trace spans added for new request paths and background workers.
- [ ] Errors mapped to every interface (RESP, HTTP, gRPC, MCP).
- [ ] Docs updated: package README, API reference, and ADR if a decision was made.
- [ ] Security reviewed: authorization checked, tenant prefix applied, no secrets logged.
- [ ] Performance considered: no CPU-heavy work on the event loop; bounded memory.
- [ ] Demo or test evidence linked in the PR.
