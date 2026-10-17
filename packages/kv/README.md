# @mindlog/kv

Redis data types and commands as deterministic, replicated operations (PLAN 5.2, 15.1, layer `domain`). Write commands are proposed as their argv and re-executed inside apply (ADR-0021). Read commands run directly on applied state.

## Public API

| Export | Purpose |
|---|---|
| `createKvRegistry()`, `allKvCommands()`, `KvCommandRegistry`, `KvCommand` | The command table: name, Redis arity, flags (`write` / `readonly` / `fast` / `denyoom`), key positions, executor |
| `kvWriteHandler`, `kvBatchHandler`, `expireHandler`, `gcThresholdHandler` | Apply handlers for `KvWrite`, `KvBatch` (MULTI/EXEC), `Expire` and `GcThreshold` |
| `KvReadExecutor` | Runs read-only commands on applied state |
| `ExpiryJob`, `GcJob` | Leader-only jobs that propose `Expire` and `GcThreshold` commands |
| `watchVersion` | WATCH version of a key (MVCC version of its header's newest change, deletes included) |
| `Keyspace`, `liveKeys`, key-layout helpers, `parseInteger`, `parseFloat64`, `formatDouble`, `globMatch`, SCAN cursor helpers, `replies` | Building blocks for commands and adapters |

## Supported commands (phase 1)

| Group | Commands |
|---|---|
| Strings | `GET` `SET` (NX/XX/GET/EX/PX/EXAT/PXAT/KEEPTTL) `SETNX` `SETEX` `PSETEX` `GETDEL` `GETEX` `MGET` `MSET` `MSETNX` `INCR` `DECR` `INCRBY` `DECRBY` `INCRBYFLOAT` `APPEND` `STRLEN` `GETRANGE` `SUBSTR` `SETRANGE` |
| Keys | `DEL` `UNLINK` `EXISTS` `TYPE` `RENAME` `RENAMENX` `DBSIZE` `SCAN` (MATCH/COUNT/TYPE) `KEYS` (refuses > 100k keys) |
| Expiry | `EXPIRE` `PEXPIRE` `EXPIREAT` `PEXPIREAT` (NX/XX/GT/LT) `TTL` `PTTL` `EXPIRETIME` `PEXPIRETIME` `PERSIST` |
| Hashes | `HSET` `HMSET` `HSETNX` `HGET` `HMGET` `HDEL` `HGETALL` `HKEYS` `HVALS` `HLEN` `HEXISTS` `HSTRLEN` `HINCRBY` `HINCRBYFLOAT` `HSCAN` |
| Lists | `LPUSH` `RPUSH` `LPUSHX` `RPUSHX` `LPOP` `RPOP` `LRANGE` `LLEN` `LINDEX` `LSET` `LTRIM` |
| Sets | `SADD` `SREM` `SMEMBERS` `SISMEMBER` `SMISMEMBER` `SCARD` `SPOP` `SRANDMEMBER` `SINTER` `SUNION` `SDIFF` `SSCAN` |
| Sorted sets | `ZADD` (NX/XX/GT/LT/CH/INCR) `ZINCRBY` `ZREM` `ZPOPMIN` `ZPOPMAX` `ZRANGE` (BYSCORE/BYLEX/REV/LIMIT/WITHSCORES) `ZREVRANGE` `ZRANGEBYSCORE` `ZREVRANGEBYSCORE` `ZRANGEBYLEX` `ZREVRANGEBYLEX` `ZSCORE` `ZMSCORE` `ZCARD` `ZCOUNT` `ZRANK` `ZREVRANK` `ZSCAN` |
| JSON | `JSON.SET` `JSON.GET` `JSON.DEL` `JSON.MGET` (paths `$`, `.`, dotted, `['k']`, `[i]`) |
| Transactions | `KvBatch` apply with WATCH versions (MULTI/EXEC/WATCH are session commands in `@mindlog/services`) |

## Storage layout (ADR-0022)

```
header   k/(key)                         KvHeader {type, generation, count, expireAtMs, version, listHead, listTail, value}
hash     k/(key, gen, 'h', field)        → value
list     k/(key, gen, 'l', seq)          → value        index i is seq listHead + i
set      k/(key, gen, 's', member)       → ∅
zset     k/(key, gen, 'z', member)       → score         and  k/(key, gen, 'Z', score, member) → ∅
expiry   $node/s/(r, rangeId, expire, atMs, tenant, key)          range-local (ADR-0028)
deadgen  $node/s/(r, rangeId, deadgen, deathVersion, tenant, key, gen)
```

A collection's generation is the MVCC version (ADR-0027) of the command that created it, so a deleted and re-created key can never see old elements. `DEL`, overwrite, `RENAME` away and expiry are a single header write plus a dead-generation record. GC reclaims the rows later.

## Invariants

- **Deterministic writes.** Write executors read the clock only as `ks.context.nowMs` (the command's HLC) and randomness only through `ks.random` (`SeededRandom(index)`). They live under `src/apply` and `src/commands` and are lint-checked for wall-clock and random globals in apply code. SPOP is tested to pop the same members on a fresh replica.
- **Valkey compatibility.** Argument parsing (`string2ll` integer rules, float forms) and error messages follow Valkey. Tests carry Valkey's test names.
- **Lazy expiry everywhere.** A key whose `expireAtMs < now` is invisible. Inside apply it is deleted on first touch. The expiry job proposes deletions for keys found due in the expiry index, and apply re-checks before deleting.
- **Empty collections are deleted**, as in Redis.
- **WATCH sees every change**, including create-then-delete, because it compares the header's newest MVCC version.
- **Range-checked writes.** Apply rejects a write whose keys are outside the range span with `RANGE_MOVED` (ADR-0029), and apply reads see only the range's keys.
- **GC never changes what is visible** (property-tested in storage; end-to-end tested here). It is bounded per command and resumable.
- **Every model test** checks random command sequences against a JavaScript model (strings, hashes, lists, sets, sorted sets).

## Metrics emitted

| Metric | Type |
|---|---|
| `mindlog_kv_expiry_proposed_total` | counter |
| `mindlog_kv_gc_removed_total` | counter |

## Known differences from Redis

- `INCRBYFLOAT` and `HINCRBYFLOAT` use IEEE double arithmetic (Redis uses long double), so results can differ in the last digits for some inputs.
- `ZRANK` and `ZRANGE` by rank are O(rank) instead of O(log n).
- `KEYS` refuses to walk more than 100,000 keys; use `SCAN`.
- JSON supports a path subset (no wildcards or filters). Numbers outside the double range lose precision.
