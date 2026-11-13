# @mindlog/server

Composition root (layer `composition`, CLAUDE.md §3.1): the only package that knows concrete adapters. It reads configuration, opens the stores, wires ports to adapters, runs the node's lifecycle and provides the `mindlog-server` CLI.

## Running

```bash
pnpm dev                                    # build, then mindlog-server --single-node: RESP :6379, HTTP :8090
node packages/server/dist/bin.js --single-node --port 6380 --http-port 8091 --data-dir ./data
redis-cli -p 6379 PING
open http://localhost:8090/_/                # dashboard (needs a superuser, below)
```

Create a dashboard superuser while the server is stopped (it holds the data directory open):

```bash
node packages/server/dist/bin.js superuser upsert admin@example.com 'a long password' --data-dir ./data
```

| Flag | Config key | |
|---|---|---|
| `--single-node` | | Run as a one-voter range, ignoring `cluster.peers`. Without it, `cluster.peers` (or `cluster.join`) must be set |
| `-c, --config <path>` | | Config file; default `./mindlog.yaml` if present |
| `-p, --port <port>` | `listen.resp.port` | `0` binds any free port |
| `--host <host>` | `listen.resp.host` | |
| `--http-port <port>` | `listen.http.port` | HTTP API, `/metrics` and dashboard; `0` binds any free port |
| `--data-dir <path>` | `node.dataDir` | |
| `--log-level <level>` | `observability.logLevel` | |

Precedence: defaults → `mindlog.yaml` → `MINDLOG_<SECTION>__<KEY>` environment variables → flags (PLAN 19.6). Any variable can instead name a file with `_FILE` (`MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE=/run/secrets/master`), and config values can be `${file:/path}`; secrets are shown in settings only through an allow-list.

Security (phase 10):

- `tls.enabled` with `tls.ca`, `tls.cert`, `tls.key` turns on TLS for RESP (`listen.resp.tls`), HTTP and MCP, and mutual TLS between nodes, to PD and to the model sidecar. The files are checked every `tls.reloadMs`; a new valid certificate is served without a restart, a broken one is logged and ignored.
- `profile: production` refuses to start without TLS or with secret files others can read (chmod 600), and RESP sessions must authenticate even without a static password.
- `storage.encryption.masterKey` (base64 of 32 bytes) encrypts a new data directory at rest (ADR-0014); an encrypted directory refuses to open without the key, or with another one. `mindlog-server keys rotate-master --new-key-file <path>` re-wraps the node's data keys, server stopped.
- `tenancy.deleteGraceMs` (default one day) is how long a deleted tenant waits before it is purged. Exit codes: `64` usage error, `78` invalid configuration, `1` startup failure (for example a data directory locked by another node or a busy port).

## Public API

| Export | Purpose |
|---|---|
| `main(argv, io)` | CLI entry: returns a running node or an exit code |
| `startNode(config, options)` | Starts a node; `RunningNode` has the bound RESP, HTTP and internal addresses, the `replica`, `replayed` and `close()` |
| `openNodeCore(config, deps)` | Opens a data directory and its range replica without client listeners (used by `superuser upsert`) |
| `redactedSettings`, `DEFAULT_DASHBOARD_DIR` | What `/api/admin/settings` shows; where `web/` builds the dashboard |
| `loadConfig`, `parseCliArgs`, `USAGE` | Configuration layering and argument parsing |
| `serverInfo`, `mindlogVersion`, `REDIS_API_VERSION` | What `INFO`, `HELLO` and `CONFIG GET` report |

## Wiring (phase 3)

```
dataDir/raftlog  LevelDbStore (format 2, sync) ── RaftLogStore ──┐
dataDir/state    LevelDbStore (format 2) ──────── StateMachine ──┼─ Replica (Raft core, Ready loop)
listen.internal  ConnectTransport (cluster only) ─────────────────┘   = Proposer + ReadBarrier
KvService (registry, stamper: HLC + ULID, StaticAuthenticator, tracer, metrics)
RespServer (CommandTable from JSON specs, connection commands, limits, resp.command spans)
HttpServer (AdminService, KvBrowser, RESP console over WebSocket, /metrics, dashboard at /_/)
ExpiryJob (100 ms) · GcJob (1 s)          → leader only: propose Expire / GcThreshold commands
MemoryService + MemoryEngine (open-memory.ts): GrpcModels behind GuardedModels, or NoModels (degraded)
JobRunner per range (500 ms)            → leader only: lease and run jobs (memory.enrich)
```

## Lifecycle

- **Start**: open both stores (the second failing closes the first) and check their format markers, open the replica (a single node replays its log and elects itself; a cluster member starts its internal listener), then listen on RESP and HTTP. `/ready` turns 200 once both listen. A listen failure releases the stores.
- **Cluster**: list every initial member in `cluster.peers` (`{ id, address }`, the same list on each node) and give each node its own `node.raftId`. A node added later starts with `cluster.join: true` and is added with `CLUSTER.ADDLEARNER` / `CLUSTER.PROMOTE`.
- **Stop** (`SIGINT`/`SIGTERM`, or `close()`): `/ready` turns 503 → close HTTP (WebSockets included) → stop accepting RESP → let in-flight commands finish → stop the jobs → close the replica (pending work gets `UNAVAILABLE`) and the internal listener → flush state → close the stores → flush traces.
- **Fail-stop**: an uncaught exception or unhandled rejection logs `fatal` and exits 1. The log replays on the next start (CLAUDE.md §4 rule 6).

## Invariants

- Only this package imports concrete adapters (LevelDB, `net`, pino, OpenTelemetry); everything else depends on ports.
- A write is acknowledged only after its log entry is fsynced and applied. Restart after `kill -9` replays the log, so no acknowledged write is lost (`test/integration/crash-durability.test.ts`).

## Metrics emitted

None of its own: the wired packages emit theirs (`mindlog_kv_*`, `mindlog_resp_*`, `mindlog_http_*`, `mindlog_statemachine_*`, `mindlog_eventbus_*`), scraped at `GET /metrics`. With `observability.tracing.endpoint` set, traces go to OTLP/HTTP; a RESP write produces `resp.command → kv.<cmd> → storage.write, statemachine.apply` (`test/integration/trace.test.ts`).
