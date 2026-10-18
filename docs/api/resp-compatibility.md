# RESP compatibility

Mindlog speaks RESP2 and RESP3 on port 6379 (PLAN 15.1), so Redis clients such as ioredis, node-redis, redis-py, `redis-cli` and `redis-benchmark` work unchanged for the commands below. Behaviour and error messages follow Valkey unless listed under [Differences](#differences). Command metadata (`COMMAND`, `COMMAND DOCS`) comes from the JSON specs in `packages/adapter-resp/commands/`.

Every write is appended to the durable log and applied before it is acknowledged (ADR-0005, ADR-0021). A `+OK` therefore survives `kill -9`.

## Supported commands (phase 3)

| Group | Commands |
|---|---|
| Strings | `GET` `SET` `SETNX` `SETEX` `PSETEX` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `INCR` `DECR` `INCRBY` `DECRBY` `INCRBYFLOAT` `APPEND` `STRLEN` `GETRANGE` `SUBSTR` `SETRANGE` |
| Keys | `DEL` `UNLINK` `EXISTS` `TYPE` `RENAME` `RENAMENX` `SCAN` `KEYS` |
| Expiry | `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` `TTL` `PTTL` `EXPIRETIME` `PEXPIRETIME` `PERSIST` |
| Hashes | `HSET` `HMSET` `HSETNX` `HGET` `HMGET` `HDEL` `HGETALL` `HKEYS` `HVALS` `HLEN` `HEXISTS` `HSTRLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LRANGE` `LLEN` `LINDEX` `LSET` `LTRIM` |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SINTER` `SUNION` `SDIFF` `SSCAN` |
| Sorted sets | `ZADD` `ZINCRBY` `ZREM` `ZPOPMIN` `ZPOPMAX` `ZRANGE` `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZSCORE` `ZMSCORE` `ZCARD` `ZCOUNT` `ZRANK` `ZREVRANK` `ZSCAN` |
| JSON | `JSON.SET` `JSON.GET` `JSON.DEL` `JSON.MGET` |
| Transactions | `MULTI` `EXEC` `DISCARD` `WATCH` `UNWATCH` |
| Connection | `PING` `ECHO` `AUTH` `HELLO` `SELECT` `QUIT` `RESET` `CLIENT ID` `CLIENT GETNAME` `CLIENT SETNAME` `CLIENT SETINFO` `CLIENT INFO` `CLIENT LIST` |
| Server | `DBSIZE` `TIME` `INFO` `CONFIG GET` `COMMAND` `COMMAND COUNT` `COMMAND INFO` `COMMAND DOCS` `COMMAND LIST` |
| Cluster (Mindlog) | `CLUSTER.INFO` `CLUSTER.ADDLEARNER` `CLUSTER.PROMOTE` `CLUSTER.REMOVE` `CLUSTER.TRANSFER` (ADR-0006) |
| Memory (Mindlog) | `MEM.ADD` `MEM.SEARCH` `MEM.GET` `MEM.FORGET` `MEM.HISTORY` (PLAN 15.1; scope is `user[/agent[/session]]` under the connection's tenant) |

## Protocol

- `HELLO 2|3 [AUTH user pass] [SETNAME name]` switches protocol; the `HELLO` reply already uses the new one. Version 4 or higher returns `-NOPROTO`.
- RESP3 replies use maps (`HGETALL`, `CONFIG GET`, `HELLO`), sets (`SMEMBERS`, `SINTER`, ...), doubles (`ZSCORE`, `INCRBYFLOAT` in sorted sets), nulls and nested `[member, score]` pairs (`WITHSCORES`, `ZPOPMIN`). RESP2 downgrades them as Valkey does: flat arrays, bulk-string doubles, `$-1` nulls and flattened pairs.
- Inline commands (`PING\r\n`, quoting as in `redis-cli`) are accepted.
- Pipelining: replies keep request order, and one pipeline's replies are sent in as few socket writes as possible.

## Limits

| Setting (`limits.*`) | Default | Behaviour when exceeded |
|---|---|---|
| `maxClients` | 10,000 | New connection gets `-ERR max number of clients reached` and is closed |
| `maxBulkBytes` | 512 MiB | `-ERR Protocol error: invalid bulk length`, connection closed |
| `maxInlineBytes` | 64 KiB | `-ERR Protocol error: too big inline request` (or `... count string`), connection closed |
| `maxArgs` | 1,048,576 | `-ERR Protocol error: invalid multibulk length`, connection closed |
| `outputBufferBytes` | 64 MiB | A client that stops reading is disconnected (`mindlog_resp_disconnects_total{reason="output-limit"}`) |
| `idleTimeoutMs` | 0 (off) | Idle connections are closed |
| `maxPipelineCommands` | 1,024 | The connection stops reading until queued commands are answered |
| `maxTransactionCommands` | 10,000 | The command is rejected and `EXEC` aborts with `-EXECABORT` |
| `maxPendingProposals` | 10,000 | Writes get `-BUSY` until the log catches up |

## Errors

Error prefixes come from the single error table in `@mindlog/core` (`ERROR_CODES`): `ERR`, `WRONGTYPE`, `NOAUTH`, `WRONGPASS`, `EXECABORT`, `NOPROTO`, `BUSY` (backpressure, retry), `TRYAGAIN` (no leader known, or leadership could not be confirmed; retry), `TIMEOUT` (a write was not applied in time and may still be applied), `MOVED` (phase 4).

## Differences

| Area | Mindlog | Valkey |
|---|---|---|
| Databases | One keyspace per tenant: `SELECT 0` only | 16 databases |
| `DEL` / `UNLINK` | O(1) per key: a header write plus a dead-generation record; replicated GC reclaims elements later (ADR-0022) | `DEL` is O(N) in elements |
| `SPOP` / `SRANDMEMBER` | Random choice is seeded by the log index, so every replica picks the same members | Process randomness |
| `EXEC` aborted by `WATCH` | Null reply (`_` / `$-1`) | Null array (`*-1` in RESP2); clients read both as null |
| Connection commands in `MULTI` | `HELLO`, `CLIENT`, `INFO`, `CONFIG`, `COMMAND`, `SELECT` are rejected and abort the transaction | Queued |
| `INFO` | Sections `server`, `clients`, `persistence`, `replication` | All sections |
| `CONFIG` | `GET` only, read-only view; configure through `mindlog.yaml` | `GET`, `SET`, `REWRITE`, ... |
| `COMMAND` | ACL categories derived from flags; one key spec per command; no `GETKEYS` | Full metadata |
| `HELLO` | `server: mindlog`, `version: 7.2.0` (the Redis API level) | `server: valkey` |
| `INCRBYFLOAT`, `HINCRBYFLOAT` | IEEE double arithmetic | long double |
| `ZRANK`, `ZRANGE` by rank | O(rank) | O(log N) |
| `KEYS` | Refuses to walk more than 100,000 keys; use `SCAN` | Unbounded |
| `SET` | Also supports `IFEQ comparison` (Valkey 8.1) | Same from Valkey 8.1 |
| Replication | Every node of a cluster accepts reads and writes: writes are forwarded to the Raft leader, and reads wait for a lease or ReadIndex check (ADR-0007), so any node returns linearizable results | Primary accepts writes; replicas serve possibly stale reads |
| JSON | Path subset: `$`, `.`, dotted, `['k']`, `[i]`; no wildcards or filters | RedisJSON / valkey-json |

Not yet supported: pub/sub, Lua and functions, streams, blocking commands (`BLPOP`, ...), bitmaps, HyperLogLog, geo, `OBJECT`, `DUMP`/`RESTORE`, `MONITOR`, client tracking, `CLIENT KILL`/`PAUSE`, ACL users (phase 10) and Redis Cluster commands (`CLUSTER SLOTS`, ...; phase 4 brings `MOVED` routing). They return `-ERR unknown command`.
