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
| `--single-node` | | Required in phase 1 (clustering arrives in phase 3) |
| `-c, --config <path>` | | Config file; default `./mindlog.yaml` if present |
| `-p, --port <port>` | `listen.resp.port` | `0` binds any free port |
| `--host <host>` | `listen.resp.host` | |
| `--http-port <port>` | `listen.http.port` | HTTP API, `/metrics` and dashboard; `0` binds any free port |
| `--data-dir <path>` | `node.dataDir` | |
| `--log-level <level>` | `observability.logLevel` | |

Precedence: defaults → `mindlog.yaml` → `MINDLOG_<SECTION>__<KEY>` environment variables → flags (PLAN 19.6). Exit codes: `64` usage error, `78` invalid configuration, `1` startup failure (for example a data directory locked by another node or a busy port).

## Public API

| Export | Purpose |
|---|---|
| `main(argv, io)` | CLI entry: returns a running node or an exit code |
| `startNode(config, options)` | Starts a node; `RunningNode` has the bound RESP and HTTP addresses, `replayed` and `close()` |
| `openNodeCore(config, deps)` | Opens and recovers a data directory without listeners (used by `superuser upsert`) |
| `redactedSettings`, `DEFAULT_DASHBOARD_DIR` | What `/api/admin/settings` shows; where `web/` builds the dashboard |
| `loadConfig`, `parseCliArgs`, `USAGE` | Configuration layering and argument parsing |
| `serverInfo`, `mindlogVersion`, `REDIS_API_VERSION` | What `INFO`, `HELLO` and `CONFIG GET` report |

## Wiring (phase 2)

```
dataDir/raftlog  LevelDbStore (sync) ── LocalLog ──┐
dataDir/state    LevelDbStore ──────── StateMachine ┼─ recover() replays appliedIndex+1..last
                                                    └─ LocalProposer (group commit, BUSY)
KvService (registry, stamper: HLC + ULID, StaticAuthenticator, tracer, metrics)
RespServer (CommandTable from JSON specs, connection commands, limits, resp.command spans)
HttpServer (AdminService, KvBrowser, RESP console over WebSocket, /metrics, dashboard at /_/)
ExpiryJob (100 ms) · GcJob (1 s)          → propose Expire / GcThreshold commands
```

## Lifecycle

- **Start**: open both stores (the second failing closes the first), replay the log into state, then listen on RESP and HTTP; `/ready` turns 200 once both listen. A listen failure releases the stores.
- **Stop** (`SIGINT`/`SIGTERM`, or `close()`): `/ready` turns 503 → close HTTP (WebSockets included) → stop accepting RESP → let in-flight commands finish → stop the jobs → drain the proposer → checkpoint (flush state, compact the log, record the truncation point) → close the stores → flush traces.
- **Fail-stop**: an uncaught exception or unhandled rejection logs `fatal` and exits 1. The log replays on the next start (CLAUDE.md §4 rule 6).

## Invariants

- Only this package imports concrete adapters (LevelDB, `net`, pino, OpenTelemetry); everything else depends on ports.
- A write is acknowledged only after its log entry is fsynced and applied. Restart after `kill -9` replays the log, so no acknowledged write is lost (`test/integration/crash-durability.test.ts`).

## Metrics emitted

None of its own: the wired packages emit theirs (`mindlog_kv_*`, `mindlog_resp_*`, `mindlog_http_*`, `mindlog_statemachine_*`, `mindlog_eventbus_*`), scraped at `GET /metrics`. With `observability.tracing.endpoint` set, traces go to OTLP/HTTP; a RESP write produces `resp.command → kv.<cmd> → storage.write, statemachine.apply` (`test/integration/trace.test.ts`).
