---
description: Use Mindlog as a replicated, Redis-compatible key-value store.
---

# Key-value store (Redis)

Mindlog speaks RESP2 and RESP3, so existing Redis clients (`redis-cli`, ioredis, node-redis, redis-py, `redis-benchmark`) work unchanged. Unlike a single Redis process, every write goes through a Raft log: it is replicated to a majority and fsynced before the client sees `OK`.

## Data types

| Type | Commands | Notes |
|---|---|---|
| Strings and counters | `GET` `SET` `MGET` `MSET` `INCR` `INCRBYFLOAT` `APPEND` `GETRANGE` `SETRANGE` … | `SET … IFEQ <value>` is a compare-and-set |
| Hashes | `HSET` `HGET` `HGETALL` `HINCRBY` `HSCAN` … | |
| Lists | `LPUSH` `RPUSH` `LPOP` `RPOP` `LRANGE` `LTRIM` `LSET` … | No blocking pops |
| Sets | `SADD` `SMEMBERS` `SINTER` `SUNION` `SDIFF` `SPOP` … | Random picks are seeded by the log index, so every replica agrees |
| Sorted sets | `ZADD` `ZRANGE` (by rank, score or lex) `ZINCRBY` `ZPOPMIN` … | |
| JSON | `JSON.SET` `JSON.GET` `JSON.DEL` `JSON.MGET` | Paths: `$`, dotted, `['k']`, `[i]` |

`DEL` and `UNLINK` are O(1) whatever the size of the value: they bump a generation number, and replicated garbage collection reclaims the elements later.

## Expiry

`EXPIRE`, `PEXPIRE`, `EXPIREAT`, `SET … EX`, `GETEX` and friends work as in Redis. An expired key is invisible to reads at once (lazy expiry). Physical removal is a **replicated** command proposed by the leader, never a local decision, so every replica removes the same keys at the same log index.

## Transactions

```
MULTI
INCRBY balance:alice -10
INCRBY balance:bob 10
EXEC
```

* `MULTI` / `EXEC` is applied as **one replicated batch**: all or nothing, isolated from other clients.
* `WATCH key …` gives optimistic concurrency. `EXEC` returns null if a watched key changed.
* Keys must live in the same range. With `features.crossRangeTxn: true`, multi-key commands and transactions that span ranges use Percolator-style two-phase commit with snapshot isolation. Without it they fail with `-CROSSSLOT`.

## Consistency

Any node accepts any command. Writes are forwarded to the range's Raft leader; reads are served by the leader while its lease is valid, or after a ReadIndex round. Every node therefore returns **linearizable** results; there are no stale replica reads.

| Level | Used by | How |
|---|---|---|
| `lease` | Ordinary reads | The leader answers while its lease (9 ticks, below the election timeout) holds |
| `linearizable` | `WATCH`/`EXEC`, admin | A ReadIndex round with a quorum |
| `snapshot` | `ASOF` reads of memory | An MVCC read at a past version |

## Iterating keys

Use `SCAN cursor [MATCH pattern] [COUNT n] [TYPE type]` (and `HSCAN`, `SSCAN`, `ZSCAN`). `KEYS` works but refuses to walk more than 100,000 keys.

## Authentication and tenants

Without `auth.password` or API keys, connections act in tenant `default`. With API keys:

```
AUTH mlk_…          # the key fixes the tenant and the role
```

`auth.password` enables the classic single-user `AUTH <password>`. Each tenant has exactly one keyspace (`SELECT 0` only), and tenants never see each other's keys.

## Over HTTP

The same data is available as JSON at `/api/kv/keys` (scan, read, write, delete, set TTL), which the dashboard's **Data** page uses. See [HTTP API](../api/http.md).

## Limits and backpressure

Connection, request and pipeline limits are in `limits.*` ([Configuration](../reference/configuration.md)). When the log falls behind, writes get `-BUSY`; when a node does not currently know a leader, `-TRYAGAIN`. Clients should retry both with backoff. Everything Mindlog does differently from Redis is listed in [RESP commands → Differences](../api/resp-compatibility.md#differences).
