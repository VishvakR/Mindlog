# @mindlog/transport

Node-to-node Raft messaging over Connect's gRPC protocol on HTTP/2 (ADR-0025, layer `replication`). It implements the `RaftTransport` port of `@mindlog/multiraft` and listens on `listen.internal` (port 7000).

## Public API

| Export | Purpose |
|---|---|
| `ConnectTransport.start(options)` | Starts the `mindlog.v1.RaftService` server and returns the transport. Also `address`, `close()` |

## Behaviour

- `Send` is one long-lived client stream per peer, carrying one batch (`SendRequest`) per Ready, in order.
- `Snapshot` is one client stream per snapshot: the SNAPSHOT message first, then key/value chunks of `raft.snapshotChunkBytes`.
- Best effort, like Raft:
  - each peer has a bounded queue (`maxQueuedBatches`), and overflow is dropped and counted;
  - a broken stream is reported as unreachable and reopened after `reconnectMs`.
- TLS hooks are the HTTP/2 server and client options; certificates arrive in phase 10.

## Metrics emitted

| Metric | Type |
|---|---|
| `mindlog_transport_sent_messages_total` | counter |
| `mindlog_transport_dropped_messages_total` | counter |
