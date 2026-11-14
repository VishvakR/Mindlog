---
description: Every configuration key, its default, and how files, environment variables, secrets and flags combine.
---

# Configuration

## Sources and precedence

Settings are resolved in this order; later sources win:

1. Built-in defaults (below).
2. The YAML file: `-c <path>`, or `./mindlog.yaml` if it exists.
3. Environment variables `MINDLOG_<SECTION>__<KEY>`: sections and keys separated by `__`, each segment in SNAKE_CASE that becomes camelCase. Examples: `MINDLOG_LISTEN__RESP__PORT=6380`, `MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051`, `MINDLOG_MEMORY__CONFLICTS__POLICY=ask_human`.
4. Command-line flags ([CLI](cli.md)).

The schema is **strict**: an unknown key, from any source, is an error at startup (exit code 78), so a typo never passes silently.

### Secrets

* In YAML, `${VAR}` reads an environment variable and `${file:/path}` reads a file.
* Any environment variable can be given as a file: `MINDLOG_STORAGE__ENCRYPTION__MASTER_KEY_FILE=/run/secrets/master-key`.
* With `profile: production`, secret files must not be readable by other users (`chmod 600`).
* `GET /api/admin/settings` and the dashboard **Settings** page show the effective configuration with secrets replaced.

```yaml
# mindlog.yaml: a small example
node:
  id: node-1
  dataDir: /var/lib/mindlog
models:
  endpoint: 127.0.0.1:50051
memory:
  conflicts:
    policy: quarantine_new
blob:
  default: { type: s3, endpoint: https://s3.example.com, bucket: mindlog,
             accessKeyId: '${file:/run/secrets/s3-id}', secretAccessKey: '${file:/run/secrets/s3-secret}' }
backup:
  intervalMs: 3600000
```

## `node`

| Key | Default | Meaning |
|---|---|---|
| `id` | `node-1` | Human-readable node name |
| `raftId` | `1` | Raft member id: non-zero and never reused |
| `dataDir` | `./data` | Data directory |
| `zone` | `local-a` | Failure zone, used to spread replicas |

## `cluster`

| Key | Default | Meaning |
|---|---|---|
| `peers` | `[]` | Initial members: `[{id, address: 'host:7000'}]` |
| `join` | `false` | Start empty and wait to be added (a new node) |
| `maxClockOffsetMs` | `500` | A node whose clock is further off fences itself |
| `pdEndpoints` | `[]` | Placement-driver addresses (`host:7100`). Empty: run an embedded PD (single node), or none |
| `advertise` | — | `host:port` other nodes reach this node's `listen.internal` at (for nodes not in `peers`) |

## `pd` (placement driver)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | This process also serves a PD replica |
| `listen` | `0.0.0.0:7100` | PD listener (`{host, port}`) |
| `dataDir` | `<node.dataDir>/pd` | PD data |
| `peers` | `[]` | PD group members; empty means one voter |
| `storeHeartbeatMs` | `10000` | Node heartbeat interval |
| `rangeHeartbeatMs` | `2000` | Range heartbeat interval |
| `deadAfterMs` | `300000` | A silent node is declared dead and repaired around |
| `schedulerIntervalMs` | `1000` | Scheduler loop |
| `tsoWindowMs` | `3000` | Timestamp-oracle window allocated per persist |

## `ranges`

| Key | Default | Meaning |
|---|---|---|
| `maxBytes` | 64 MiB | Split above this size |
| `mergeBelowBytes` | 16 MiB | Merge neighbours below this size |
| `splitQps` | `2500` | Split when load stays above this… |
| `splitQpsWindowMs` | `60000` | …for this long |
| `replicas` | `3` | Replicas per range |

## `models`

| Key | Default | Meaning |
|---|---|---|
| `endpoint` | unset | Model service `host:port`. Unset: memory runs in degraded mode |
| `timeoutMs` | `2000` | Per call |
| `breakerFailures` | `5` | Consecutive failures that open the breaker |
| `breakerOpenMs` | `10000` | How long it stays open |

## `memory`

| Key | Default | Meaning |
|---|---|---|
| `conflicts.threshold` | `0.95` | Contradiction probability that raises a conflict (0.5–1) |
| `conflicts.minSimilarity` | `0.5` | Cosine a fact needs to be compared at all |
| `conflicts.policy` | `quarantine_new` | `quarantine_new`, `newest_wins`, `ask_human`, `prefer_verified` |
| `trust.tools` | `[]` | Tool names whose output is trusted (`normal`) |
| `trust.domains` | `[]` | Web/document domains that are trusted |
| `consolidation.enabled` | `true` | Background workers on/off |
| `consolidation.tickMs` | 15 min | Between ticks of a scope with work left |
| `consolidation.idleMs` | 10 min | Delay of the first tick after a write |
| `consolidation.sleepAfter` | `20` | New memories that trigger sleep-time consolidation once idle |
| `consolidation.sleepEveryMs` | 24 h | Sleep-time at least this often |
| `consolidation.maxConflicts` | `3` | A sleep branch raising more conflicts is dropped |
| `consolidation.modelSecondsPerHour` | `600` | Model time per tenant per node for background work |
| `split.maxMemories` | `100000` | Scope size that triggers a semantic split (0 = never) |
| `split.driftRatio` | `1.5` | Cluster imbalance that triggers a re-split |
| `split.recallClusters` | `2` | Clusters searched per recall (1–8) |
| `forgetting.coldBelow` | `0.2` | Retention that moves a memory to the cold tier |
| `forgetting.hardForgetTenants` | `[]` | Tenants that allow hard deletion of faded memories |
| `forgetting.deleteBelow` | `0.02` | Retention below which those tenants delete |

## `storage` and `blob`

| Key | Default | Meaning |
|---|---|---|
| `storage.coldTier.enabled` | `true` | Use the cold tier |
| `storage.encryption.masterKey` | unset | Base64 of 32 bytes; enables encryption at rest on a **new** data directory |
| `blob.default` | `{type: local, path: blobs}` | `local` (`path`, relative to `dataDir`) or `s3` (`endpoint`, `bucket`, `region` = `us-east-1`, `accessKeyId`, `secretAccessKey`) |

## `backup`

| Key | Default | Meaning |
|---|---|---|
| `intervalMs` | `0` | Full backup interval; 0 = off |
| `keep` | `7` | Backups kept |
| `verify` | `false` | Restore the previous backup in memory after each one |

## `features`

| Key | Default | Meaning |
|---|---|---|
| `crossRangeTxn` | `false` | Percolator transactions across ranges |
| `semanticSplit` | `false` | Split very large memory scopes |

## `raft`

| Key | Default | Meaning |
|---|---|---|
| `tickMs` | `100` | Tick length |
| `electionTicks` | `[10, 20]` | Randomized election timeout range |
| `heartbeatTicks` | `1` | Heartbeat interval |
| `leaseTicks` | `9` | Leader lease; must be below `electionTicks[0]` |
| `maxInflightMsgs`, `maxInflightBytes` | `256`, 16 MiB | Replication pipelining |
| `maxEntryBatchBytes` | 1 MiB | Entries per append |
| `snapshotEntries` | `10000` | Entries between snapshots |
| `trailingEntries` | `1000` | Entries kept after a snapshot for slow followers |
| `snapshotChunkBytes` | 1 MiB | Snapshot streaming chunk |

## `listen`

| Key | Default | Meaning |
|---|---|---|
| `resp` | `0.0.0.0:6379`, `tls: false` | RESP listener |
| `http` | `0.0.0.0:8090` | REST, SSE, dashboard, metrics |
| `grpc` | `0.0.0.0:9090` | Reserved for a public gRPC API |
| `internal` | `0.0.0.0:7000` | Raft, snapshots and forwarding between nodes |
| `mcp.http` | `127.0.0.1:8765`, `allowedHosts: []` | MCP Streamable HTTP. Other bind addresses must list their host names |
| `mcp.stdio` | `true` | Allow the stdio relay |

## `observability`

| Key | Default | Meaning |
|---|---|---|
| `logLevel` | `info` | `trace` … `fatal` |
| `tracing.endpoint` | unset | OTLP/HTTP endpoint; unset = no tracing (no network calls) |
| `tracing.sampleRatio` | `0.05` | Fraction of traces sampled |

## `limits`

| Key | Default | Meaning |
|---|---|---|
| `maxClients` | `10000` | Connections |
| `maxBulkBytes` | 512 MiB | RESP bulk string |
| `maxInlineBytes` | 64 KiB | RESP inline request |
| `maxArgs` | 1,048,576 | Arguments per command |
| `outputBufferBytes` | 64 MiB | Unsent replies before a client is disconnected |
| `idleTimeoutMs` | `0` | Idle connection timeout (0 = off) |
| `maxPipelineCommands` | `1024` | Queued commands per connection |
| `maxTransactionCommands` | `10000` | Commands inside one `MULTI` |
| `maxPendingProposals` | `10000` | Proposals before writes get `BUSY` |
| `authBurst`, `authPerMinute` | `20`, `30` | Sign-in rate per client address |

## `auth`

| Key | Default | Meaning |
|---|---|---|
| `password` | unset | Classic RESP `AUTH <password>` for the default user |
| `oauth2` | `[]` | `[{name, clientId, clientSecret, issuer?}]`; `google` and `github` have presets, others need an OIDC `issuer` |

## `collections`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | App-backend collections |
| `tenants` | `[]` | Tenants with collections; empty = every user tenant |
| `defaultTenant` | `default` | Tenant of requests that name none |
| `appUrl` | `''` | Public app URL, for links in mail |
| `migrationsDir` | `''` | Migration files run at startup |
| `hooksDir` | `''` | Hook files |

## `mail`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `off` | `off`, `console` (log mail), `smtp` |
| `from` | `noreply@mindlog.local` | Sender |
| `host`, `port` | `127.0.0.1`, `587` | SMTP server |
| `tls`, `requireTls` | `false`, `true` | Implicit TLS; refuse to send without STARTTLS |
| `username`, `password` | unset | SMTP credentials |

## `tls`

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | TLS on RESP, HTTP and MCP; mutual TLS between nodes, PD and the model sidecar |
| `ca`, `cert`, `key` | unset | PEM file paths |
| `reloadMs` | `5000` | How often certificate files are checked for rotation |

## `tenancy` and `profile`

| Key | Default | Meaning |
|---|---|---|
| `tenancy.deleteGraceMs` | 1 day | Delay before a deleted tenant is purged |
| `profile` | `dev` | `production` refuses to start without TLS or with readable secret files |
