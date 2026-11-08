# @mindlog/services

Application services (layer `application`): sessions, authentication, and the KV request path shared by every protocol adapter. Adapters parse and serialise; everything else happens here or below (CLAUDE.md §9).

## Public API

| Export | Purpose |
|---|---|
| `KvService` | `openSession(id)`, `execute(session, argv)` → `KvReply`, `authenticate(session, user, password)`, `authenticationRequired` |
| `Session` | Per-connection tenant, principal, authentication flag, MULTI queue and WATCHed keys |
| `StaticAuthenticator` | Phase 1 auth: one `default` user with `auth.password`; constant-time comparison |
| `commandName` | Upper-cased command name from argv |
| `MemoryService` | Memory requests from every interface (PLAN 12, ADR-0016): `remember`, `recall` (recipes, explain, packed context), `get`, `list`, `forget`, `history`, `graph`, `scopes`, the semantic cache's `cacheLookup`, `cacheStore`, `cacheDelete` (ADR-0012), conflict review (`conflicts`, `resolve`, `trust`; ADR-0015) and branches (`createBranch`, `branches`, `diffBranch`, `mergeBranch`, `dropBranch`; ADR-0013). Lifecycle (ADR-0033): `pin`, `consolidate`, `jobs` (with the scope's lifecycle counts), `exportCube` and `importCube` (archives as base64); `remember` takes a `toolTrace` and `recall` takes `includeCold`. Reads take `asOf`, `validAt` and `branch`; `forget` takes a `source` for the taint cascade. Validates with the shared Zod schemas (parsed values stay JSON, because a forwarded request is parsed again), finds the user scope's range (`RangeRouter.locate`), runs the engine on the leader here or forwards a `memory` call, and retries `NOT_LEADER`/`RANGE_MOVED` with the origin's request id. Memory writes wait for cluster version 5, cache writes for 6, review, branch commands and any write on a branch for 7, lifecycle writes for 8. |
| `ChangeFeed` | The memory change stream (PLAN 6.3, 13.5): `changesOf` maps each applied memory command to events (`memory.added`/`forgotten`/`evolved`, `conflict.raised`/`resolved`, `branch.created`/`merged`/`dropped`) with a `rangeId:index` cursor; `subscribe(filter, from, listener)` replays the held tail after a cursor or sends `resync`, then follows. Keeps the last 1,000 events per range; failed and repeated commands produce none. |
| `rememberSchema` … `scopesSchema` | Zod schemas of the memory requests, shared by RESP, REST and MCP |

## Request path

```
execute(session, argv)
  ├─ not authenticated and not AUTH        → NOAUTH
  ├─ AUTH / MULTI / EXEC / DISCARD / WATCH / UNWATCH   (session commands)
  ├─ inside MULTI                          → validate (name, arity) and queue → QUEUED
  ├─ read-only command                     → ReadBarrier (lease) → KvReadExecutor on applied state
  └─ write command                         → stamp (ULID + HLC) → Proposer → KvReply
```

## Collections (PLAN 16, ADR-0034, ADR-0035)

- **`CollectionService`**: schema administration for superusers (`saveCollection`, `deleteCollection`, `checkRuleText` for the rule editor) and record CRUD for everyone else (`list`, `view`, `create`, `update`, `delete`), under the collection rules with PocketBase's status conventions:
  - a locked rule (`null`) is `PERMISSION_DENIED` unless the requester is a superuser;
  - a failed list rule filters the list, a failed view, update or delete rule is `NOT_FOUND`, a failed create rule is `INVALID_ARGUMENT`.
- Requests are routed to the leader of the collection's range (`CollectionRanges`, local or through the forwarding RPC as `collections.<op>` calls). Reads wait for the lease read barrier.
- `RecordReader` evaluates rules as the requester (relations and `@collection` rows through a resolver), plans list scans through indexes (at most `MAX_SCAN` = 10,000 rows per request), expands relations (each checked with its `viewRule`) and hides hidden fields and private emails.
- `RecordWriter` resolves field modifiers, hashes passwords (and rotates `tokenKey`), sets autodates, embeds `vector` fields (degraded without models), checks relations exist, then proposes one `RecordWrite` fenced by the version it read; a `CONFLICT` is retried.
- `Catalog` caches the tenant's schemas for 2 s (`shortcut:`).
- **`AppAuthService`**: password sign-in with 15-minute HS256 access tokens (`JwtKeySet` in `$system`) and rotating refresh tokens (`_sessions`), delegated agent tokens, file tokens, and the opt-in OTP (`_otps`), verification, password reset and OAuth2 (`_externalAuths`) flows. System collections are created on first use.
- **Jobs** (`collectionWorkers`) live in the collection's range: relation cascades, the file janitor, view refresh, after hooks and cron. `RecordFiles` writes blobs after the rules passed and before proposing; `RecordBroker` filters realtime events per subscriber.
- **Hooks** are the `RecordHooks` port: before hooks run after the rule check and may change the body or refuse; after hooks are jobs enqueued in the write; `ensureCrons` starts one self-rescheduling job per cron.
- Writes need cluster version 9 (`COLLECTIONS_CLUSTER_VERSION`).

## Invariants

- **Authorization before anything else.** With a password configured, only `AUTH` runs before authentication. Without one, the `default` user is `nopass` as in Valkey: `AUTH default <anything>` succeeds, while one-argument `AUTH` is an error.
- **Writes are proposed, never executed locally**, so every write is durable and replicated before it is acknowledged.
- **Bounded transactions.** One MULTI queues at most `maxTransactionCommands` (default 10,000); the next command is rejected and EXEC aborts.
- **Queue-time validation.** An unknown command or wrong arity inside MULTI aborts the EXEC with `EXECABORT`, as in Valkey. Runtime errors stay per command inside the EXEC reply.
- **WATCH compares header versions**, read after a linearizable ReadBarrier, so any change (including create-then-delete) aborts EXEC.
- **Reads wait for the ReadBarrier** (ADR-0007): `lease` by default, so a follower or a deposed leader never serves stale data.
- **Bounded telemetry labels.** Unknown command names are labelled `unknown`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_kv_command_latency_seconds` | histogram | `command` |
| `mindlog_kv_command_errors_total` | counter | `command`, `code` |

Spans: `kv.<command>` with `mindlog.tenant` and `mindlog.command`.
