# Changelog

All notable changes to Mindlog. Versions follow [Semantic Versioning](https://semver.org).

## [1.0.0] - 2026-11-13

The first release: a Redis-compatible, Raft-replicated database that is also long-term memory for AI agents, and optionally an app backend. Measured results are in `docs/slo.md`, and per-phase evidence in `docs/phases/`.

### Database
- RESP2/3 server: strings, hashes, lists, sets, sorted sets, a JSON subset, TTLs, `SCAN`, `MULTI`/`EXEC`/`WATCH`, `SET … IFEQ`. Tested with ioredis and redis-py.
- Storage: two LevelDB instances (log and state), MVCC with replicated GC, kill -9 safe.
- Raft:
  - a pure core with PreVote, CheckQuorum, ReadIndex, leases, snapshots, learners, single-server membership changes and leadership transfer;
  - a deterministic simulator;
  - Jepsen Maelstrom `lin-kv`.
- Multi-Raft ranges with split and merge, a placement driver (directory, TSO, schedulers, operators), request routing, and Percolator cross-range transactions (behind a flag).

### Agent memory
- A Python model sidecar on ONNX: embeddings, rerank, NLI, GLiNER entities, extraction.
- Ingestion and recall pipelines: vector, BM25, entity and PPR retrievers, named recipes, rerank, MMR, token-budget packing.
- Degraded mode, with durable enrichment jobs, when the models are down.
- MCP server (Streamable HTTP and a stdio relay), `MEM.*` over RESP, and `/api/memory/*` over REST.
- Conflict detection at commit time with quarantine and resolution; branches with policy merges; time travel (`ASOF`, `VALID_AT`); provenance trust and taint cascades; change streams.
- A replicated semantic cache with dependency invalidation.
- Consolidation, forgetting curve, cold tier on local disk or S3, `.mcube` export and import.
- Evals: LongMemEval and LoCoMo retrieval, conflict F1, cache false-hit rate, forgetting against LRU.

### App backend
- Collections with a rule language, app auth (argon2id, JWTs, OTP, OAuth2), files with thumbnails, realtime, views and hooks.

### Security and operations
- Tenants with six RBAC roles and policy rows, quotas and rate limits, an audit log.
- TLS/mTLS with hot reload, a `production` profile, secrets from files.
- Encryption at rest with master-key rotation; PII redaction; tenant export and crypto-shredded deletion.
- Semantic split of large memory scopes.
- SDKs for TypeScript and Python, with embedded offline replicas and LangGraph and CrewAI adapters.
- Full backups to the blob store, with `backup verify` and `backup restore` (ADR-0041).
- Runbooks, a fail-stop metric for disk errors, a dashboard (React and shadcn/ui), Prometheus metrics, OpenTelemetry traces.

### Known gaps
- No incremental backups and no point-in-time restore.
- The vector index is exact (flat): recall at 100K+ memories per scope was not measured.
- p99 KV latency on 3 nodes was not benchmarked.
- Semantic split costs 4–7 points of recall@10.
