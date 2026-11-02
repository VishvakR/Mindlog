# @mindlog/adapter-resp

RESP2/RESP3 protocol adapter (PLAN 15.1, layer `interfaces`): parser, writer, connections, the command table and the TCP server. It only parses, checks protocol-level rules and serialises; data commands go to `KvService` in `@mindlog/services` (CLAUDE.md §9). Supported commands and differences from Valkey: [`docs/api/resp-compatibility.md`](../../docs/api/resp-compatibility.md).

## Public API

| Export | Purpose |
|---|---|
| `RespParser`, `splitInline`, `DEFAULT_LIMITS` | Incremental request parser (multibulk and inline) with Valkey limits and errors |
| `RespWriter` | Serialises `KvReply` as RESP3 or downgrades to RESP2; batches a pipeline's replies |
| `loadCommandSpecs`, `CommandTable` | Validated JSON specs (`commands/*.json`) and `COMMAND` / `COMMAND INFO|DOCS|COUNT|LIST` |
| `Connection`, `ConnectionLimits`, `CloseReason` | One client: ordered pipelining, connection commands, output and pipeline limits |
| `ConnectionCommand`, `ConnectionCommandRegistry`, `createConnectionCommands()` | Commands the adapter answers itself: `HELLO` `SELECT` `QUIT` `RESET` `CLIENT` `INFO` `CONFIG GET` `COMMAND`, `CLUSTER.*` and the `MEM.*` and `CACHE.*` commands (through `ServerContext.memory`), including `MEM.CONFLICTS` `MEM.RESOLVE` `MEM.TRUST`, `MEM.BRANCH` `MEM.BRANCHES` `MEM.DIFF` `MEM.MERGE` `MEM.DROP`, the lifecycle commands `MEM.PIN` `MEM.UNPIN` `MEM.CONSOLIDATE` `MEM.JOBS` `MEM.EXPORT` `MEM.IMPORT` `MEM.TRACE` (ADR-0033), the `ASOF`, `VALID_AT`, `BRANCH` and `INCLUDE_COLD` options, and `MEM.WATCH`, which follows `ServerContext.changes` with push messages (RESP3 `>`, arrays in RESP2) until the connection closes or resets |
| `ClientRegistry`, `ClientState` | Open connections for `CLIENT LIST`, `INFO` and `maxClients` |
| `RespServer` | `net` listener: `maxClients`, idle timeout, metrics, graceful `close()` |

## Request flow

```
socket bytes → RespParser → Connection queue (in order)
   ├─ connection command (spec flags: NO_AUTH, arity) → handler → KvReply
   └─ anything else → KvService.execute(session, argv) → KvReply
KvReply → RespWriter (session protocol 2 or 3) → one socket write per pipeline
```

## Command specs

`commands/<group>.json` holds Valkey-shaped specs written for Mindlog: `summary`, `complexity`, `group`, `since`, `arity`, `command_flags`, `key_range` (`first`, `last`, `step`; negative `last` counts from the end), `arguments` and `subcommands`. They are validated with Zod at startup. Tests check that:

- every spec has exactly one implementation (kv registry, session command or connection handler), and every command has a spec;
- arity, flags and key positions match the kv registry.

To add a command: implement it, add its spec to the right group file, and list it in `docs/api/resp-compatibility.md`.

## Invariants

- **Replies keep request order**, including across chunk boundaries and slow writes.
- **The parser's result never depends on how bytes are chunked** (fuzzed with `pnpm fuzz:resp`, including mutated pipelines).
- **A protocol error is answered after the commands before it, then the connection closes**, as in Valkey.
- **Every connection is bounded**: parser limits, `maxPipeline` queued commands (reading pauses beyond it), and `outputBufferBytes` unsent bytes (the client is disconnected beyond it).
- **No business logic here**: errors come from `ERROR_CODES`, and data commands go through `KvService`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_resp_connections_count` | gauge | |
| `mindlog_resp_connections_accepted_total` | counter | |
| `mindlog_resp_connections_rejected_total` | counter | |
| `mindlog_resp_disconnects_total` | counter | `reason`: quit, protocol-error, output-limit, idle, peer, server |
| `mindlog_resp_received_bytes_total` | counter | |

Per-command latency, errors and spans are emitted by `KvService` (`mindlog_kv_command_latency_seconds`, `mindlog_kv_command_errors_total`).

## Testing

```bash
pnpm --filter @mindlog/adapter-resp test   # unit, property, golden bytes, TCP
pnpm fuzz:resp                              # long fuzz run (FUZZ_RUNS, FUZZ_SEED)
```
