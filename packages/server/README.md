# @mindlog/server

Composition root (layer `composition`, CLAUDE.md §3.1): the only package that knows concrete adapters. It reads configuration, opens the stores, wires ports to adapters, runs the node's lifecycle and provides the `mindlog-server` CLI.

## Running

```bash
pnpm dev                                    # build, then mindlog-server --single-node on :6379
node packages/server/dist/bin.js --single-node --port 6380 --data-dir ./data
redis-cli -p 6379 PING
```

| Flag | Config key | |
|---|---|---|
| `--single-node` | | Required in phase 1 (clustering arrives in phase 3) |
| `-c, --config <path>` | | Config file; default `./mindlog.yaml` if present |
| `-p, --port <port>` | `listen.resp.port` | `0` binds any free port |
| `--host <host>` | `listen.resp.host` | |
| `--data-dir <path>` | `node.dataDir` | |
| `--log-level <level>` | `observability.logLevel` | |

Precedence: defaults → `mindlog.yaml` → `MINDLOG_<SECTION>__<KEY>` environment variables → flags (PLAN 19.6). Exit codes: `64` usage error, `78` invalid configuration, `1` startup failure (for example a data directory locked by another node or a busy port).

## Public API

| Export | Purpose |
|---|---|
| `main(argv, io)` | CLI entry: returns a running node or an exit code |
| `startNode(config, options)` | Starts a node; `RunningNode` has the bound RESP address, `replayed` and `close()` |
| `loadConfig`, `parseCliArgs`, `USAGE` | Configuration layering and argument parsing |
| `serverInfo`, `mindlogVersion`, `REDIS_API_VERSION` | What `INFO`, `HELLO` and `CONFIG GET` report |

## Wiring (phase 1)

```
dataDir/raftlog  LevelDbStore (sync) ── LocalLog ──┐
dataDir/state    LevelDbStore ──────── StateMachine ┼─ recover() replays appliedIndex+1..last
                                                    └─ LocalProposer (group commit, BUSY)
KvService (registry, stamper: HLC + ULID, StaticAuthenticator, tracer, metrics)
RespServer (CommandTable from JSON specs, connection commands, limits)
ExpiryJob (100 ms) · GcJob (1 s)          → propose Expire / GcThreshold commands
```

## Lifecycle

- **Start**: open both stores (the second failing closes the first), replay the log into state, then listen. A listen failure releases the stores.
- **Stop** (`SIGINT`/`SIGTERM`, or `close()`): stop accepting → let in-flight commands finish → stop the jobs → drain the proposer → checkpoint (flush state, compact the log, record the truncation point) → close the stores → flush traces.
- **Fail-stop**: an uncaught exception or unhandled rejection logs `fatal` and exits 1. The log replays on the next start (CLAUDE.md §4 rule 6).

## Invariants

- Only this package imports concrete adapters (LevelDB, `net`, pino, OpenTelemetry); everything else depends on ports.
- A write is acknowledged only after its log entry is fsynced and applied. Restart after `kill -9` replays the log, so no acknowledged write is lost (`test/integration/crash-durability.test.ts`).

## Metrics emitted

None of its own: the wired packages emit theirs (`mindlog_kv_*`, `mindlog_resp_*`, `mindlog_statemachine_*`, `mindlog_eventbus_*`). An HTTP `/metrics` endpoint arrives with `adapter-http` in phase 2.
