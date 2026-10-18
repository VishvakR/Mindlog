# @mindlog/router

Finds the range that holds a key and reaches its leader (ADR-0029). It implements the `RangeRouter`
port that `@mindlog/services` declares.

## Public API

- `StoreRouter` — places keys: a range whose leader is on this node resolves to its live replica;
  others resolve to the leader's internal address, from the node's own Raft configuration or from a
  TTL cache of PD's directory. `refresh` drops the cache entry and places the key again.
- `connectForwardCall`, `toRequest`, `fromRequest` — carry a call to another node over the
  `KvForwardService` RPC (served by `@mindlog/transport`), stamping the sender's HLC.
- `locate(key)` places an encoded storage key, such as a memory scope's `tenant · 'm' · (user)` (ADR-0031). Memory calls travel as `ExecuteRequest.memory {op, json}` (ADR-0016).

## Invariants

- Retries (in `RoutedKv`) happen only for `NOT_LEADER` and `RANGE_MOVED`, and a retried write keeps
  its request id, so a write that did commit is not applied twice.
- With no known leader the router fails with `NOT_LEADER` before sending anything.
- The range cache never answers for a range this node holds a replica of: the live replica wins.

## Metrics

None yet; request latency and errors are recorded by the KV service and the transport.
