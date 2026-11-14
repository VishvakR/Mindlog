---
description: Every mindlog-server command and flag.
---

# CLI

The server binary is `mindlog-server` (`node packages/server/dist/bin.js` from source, the entry point of the Docker image).

## Run a node

```
mindlog-server --single-node [options]
mindlog-server -c mindlog.yaml
```

| Flag | Config key | Meaning |
|---|---|---|
| `--single-node` | — | Run one node with a one-voter Raft group and its own placement driver. Required unless `cluster.peers` or `cluster.join` is set |
| `-c, --config <path>` | — | Config file (default `./mindlog.yaml` if present) |
| `-p, --port <port>` | `listen.resp.port` | RESP port |
| `--host <host>` | `listen.resp.host` | RESP bind address |
| `--http-port <port>` | `listen.http.port` | HTTP API and dashboard port |
| `--mcp-port <port>` | `listen.mcp.http.port` | MCP Streamable HTTP port |
| `--data-dir <path>` | `node.dataDir` | Data directory |
| `--log-level <lvl>` | `observability.logLevel` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `-h, --help`, `-v, --version` | — | Help, version |

Configuration is read from defaults, then the file, then `MINDLOG_<SECTION>__<KEY>` environment variables, then flags. See [Configuration](configuration.md).

## Offline admin commands

These open the data directory directly, so **stop the node first**. Each accepts `-c <config>` and `--data-dir <path>`.

### `superuser upsert`

```
mindlog-server superuser upsert <email> <password>
```

Creates or updates an operator account (dashboard and admin APIs). Resetting the password revokes the account's tokens.

### `apikey`

```
mindlog-server apikey create --tenant <tenant> --name <name> [--user <user>]
mindlog-server apikey list
mindlog-server apikey revoke <id>
```

Creates an `agent`-role API key and prints it once. `--user` pins the key to one memory user scope. A running node manages keys with richer options (role, scopes, expiry) through the [tenant API](../guides/tenants-and-access.md#api-keys) and the dashboard.

### `keys rotate-master`

```
mindlog-server keys rotate-master --new-key-file <path>
```

Re-wraps every data key under a new master key for [encryption at rest](../operations/security.md#encryption-at-rest). Then point `storage.encryption.masterKey` at the new key. See the [runbook](../runbooks/rotate-master-key.md).

### `backup`

```
mindlog-server backup verify <id> [--from <data-dir>]
mindlog-server backup restore <id> --data-dir <new-empty-dir> [--from <data-dir>]
```

`verify` restores a backup into memory and checks it. `restore` writes it into a new data directory as a one-node cluster; start it with `--single-node --data-dir <new-dir>`. `--from` names the data directory of the node whose blob store holds the backup. See [Backups](../operations/backups.md).

## MCP stdio relay

```
mindlog-server mcp --api-key <key> [--url http://127.0.0.1:8765/mcp]
```

Relays MCP over stdio to a running node, for hosts that only launch stdio servers. `MINDLOG_API_KEY` and `MINDLOG_MCP_URL` can replace the flags. See [Connect an AI agent](../getting-started/connect-an-agent.md).

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Runtime failure (the reason is on stderr) |
| `64` | Usage error: unknown or missing flags |
| `78` | Invalid configuration: the file, environment or flags failed validation |
