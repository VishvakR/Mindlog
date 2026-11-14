# ADR-0025: Raft transport on Connect (gRPC over HTTP/2)

- Status: accepted
- Date: 2026-10-16
- PLAN: 3.3 (internal port 7000), 4.2 (`@mindlog/transport`), 7.2 (messages), 18.4 (mTLS)
- References: hashicorp-raft.md, etcd-raft.md

## Context

Nodes exchange Raft messages and stream snapshots. PLAN 4 and ADR-0004 call for protobuf over gRPC. The repo already generates TypeScript with protobuf-es v2, which emits service descriptors. The two Node.js options are `@grpc/grpc-js` (needs its own stub generation, such as ts-proto or proto-loader) and Connect (`@connectrpc/connect` + `@connectrpc/connect-node`), which speaks the gRPC protocol over HTTP/2 and consumes protobuf-es descriptors directly.

## Decision

- Use **`@connectrpc/connect` and `@connectrpc/connect-node`** with the **gRPC protocol** over HTTP/2, on `listen.internal` (port 7000).
- `proto/mindlog/v1/raft.proto` defines `RaftService` with two client-streaming RPCs:
  - `Send(stream SendRequest) returns (SendResponse)`: batches of Raft messages, one long-lived stream per peer;
  - `Snapshot(stream SnapshotRequest) returns (SnapshotResponse)`: the snapshot message first, then key/value chunks of at most `raft.snapshotChunkBytes` (1 MiB).
- The transport is fire-and-forget, like Raft itself: each peer has a bounded queue; on overflow messages are dropped and counted (`mindlog_transport_dropped_messages_total`), and Raft's retries recover. A broken stream is reopened with backoff and reported to Raft as unreachable.
- Messages carry `range_id` so phase 4 can multiplex ranges over the same streams.
- TLS is configured through the HTTP/2 server and client options; certificate files come with phase 10 (security hardening).

## Alternatives considered

- **`@grpc/grpc-js`**: mature, but a second code generator and type system next to protobuf-es.
- **Raw TCP with length-prefixed frames**: least overhead, but we would own framing, multiplexing, flow control and TLS.

## Consequences

- Two new dependencies (`@connectrpc/connect`, `@connectrpc/connect-node`), both from the protobuf-es authors.
- Python never speaks this service; it is node-to-node only. Python code generation still runs for the file and stays unused.
- The `RaftTransport` port lives in `@mindlog/multiraft`; the simulator and the Maelstrom adapter implement it without Connect.
