# Architecture decision records

Why each significant decision was made. New ones copy [`0000-template.md`](0000-template.md). Numbers are never reused; 0019 was not needed.

| ADR | Decision |
|---|---|
| [0001](0001-typescript-server-python-sidecar.md) | TypeScript server with a Python model sidecar |
| [0002](0002-hexagonal-architecture-boundaries.md) | Hexagonal architecture, package per module, enforced boundaries |
| [0003](0003-raft-log-source-of-truth.md) | The Raft log is the single source of truth; apply is deterministic |
| [0004](0004-protobuf-commands-and-rpcs.md) | Protobuf for log commands and internal RPCs |
| [0005](0005-separate-leveldb-for-raft-log.md) | Separate LevelDB instance for the log; state store without fsync |
| [0006](0006-single-server-membership-changes.md) | Single-server membership changes before joint consensus |
| [0007](0007-leader-leases-and-clock-assumptions.md) | Leader leases and clock-offset assumptions |
| [0008](0008-vector-index-flat-first.md) | Vector index — exact flat index first, HNSW later |
| [0009](0009-range-size-split-and-merge-policy.md) | Range size, split and merge policy |
| [0010](0010-placement-driver-raft-group-and-tso.md) | Placement driver as its own Raft group with a TSO |
| [0011](0011-fusion-and-scoring.md) | Retrieval fusion, scoring and recall recipes |
| [0012](0012-semantic-cache-invalidation.md) | Semantic cache with dependency invalidation inside apply |
| [0013](0013-branches-as-overlays.md) | Memory branches as overlays at a fork version |
| [0014](0014-encryption-at-rest.md) | Encryption at rest |
| [0015](0015-conflict-policy-defaults.md) | Conflict detection before commit, quarantine-new by default |
| [0016](0016-model-calls-before-proposing.md) | Model calls only before proposing; results embedded in commands |
| [0017](0017-durable-jobs-in-the-scope-range.md) | Durable jobs stored in the scope's range |
| [0018](0018-rule-language.md) | Rule language compatible with the PocketBase filter syntax |
| [0020](0020-offline-first.md) | Offline-first — no network dependency by default |
| [0021](0021-kv-writes-replicated-as-argv.md) | KV writes are replicated as command argv |
| [0022](0022-collection-generations.md) | Collection generations for O(1) delete |
| [0023](0023-dashboard-react-shadcn.md) | The dashboard is a React + shadcn/ui static app |
| [0024](0024-http-adapter-and-superusers.md) | HTTP adapter on Fastify; superusers in the system tenant with bearer tokens |
| [0025](0025-connect-rpc-raft-transport.md) | Raft transport on Connect (gRPC over HTTP/2) |
| [0026](0026-raft-log-format-v2.md) | Raft log format v2, snapshots and data-directory format markers |
| [0027](0027-mvcc-versions-as-range-timestamps.md) | MVCC versions are per-range HLC timestamps |
| [0028](0028-range-local-state-and-replica-ids.md) | Range-local system state, replica ids and the multi-range store |
| [0029](0029-request-routing-and-range-epochs.md) | Request routing, forwarding and range epochs |
| [0030](0030-percolator-transactions.md) | Cross-range transactions with Percolator |
| [0031](0031-memory-key-layout-and-scope-placement.md) | Memory key layout and scope placement |
| [0032](0032-memory-and-job-commands.md) | Memory and job commands |
| [0033](0033-memory-lifecycle.md) | Memory lifecycle: consolidation, forgetting and the cold tier |
| [0034](0034-collections.md) | Collections: key layout, commands and cluster version 9 |
| [0035](0035-app-auth.md) | App authentication: argon2id, JWTs, sessions and delegated agent tokens |
| [0036](0036-tenants-and-rbac.md) | Tenants and role-based access |
| [0037](0037-audit-log.md) | Audit log through a range-local outbox |
| [0038](0038-quotas-and-rate-limits.md) | Tenant quotas and rate limits |
| [0039](0039-semantic-split.md) | Semantic split of large memory scopes |
| [0040](0040-embedded-replica-sync.md) | Embedded replicas and SDK sync |
| [0041](0041-full-backups.md) | Full backups from range snapshots |
