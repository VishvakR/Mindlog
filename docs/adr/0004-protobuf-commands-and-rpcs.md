# ADR-0004: Protobuf for log commands and internal RPCs

- Status: accepted
- Date: 2026-10-11
- PLAN: 6.1 (command envelope), 7.2, 14.3 (model service API), 15.4, 19.5 (upgrades), 23.3
- References: [etcd-raft.md](../references/etcd-raft.md) (`raftpb`), [resp3-spec.md](../references/resp3-spec.md), [node-redis.md](../references/node-redis.md)

## Context

Three contracts need a schema that both TypeScript and Python can read, and that can evolve during rolling upgrades:
1. **Replicated commands** in the Raft log. These are persisted forever (snapshots aside) and read by future binaries.
2. **Internal RPCs**: Raft transport, snapshot streaming, forwarding, PD.
3. **The model sidecar API** (TypeScript ↔ Python).

etcd raft defines its messages in protobuf (`raftpb/`). PLAN 19.5 requires new command types to be gated by cluster version, and nodes must refuse unknown newer formats.

## Decision

- **Protocol Buffers (proto3)** in `proto/`, managed with **buf**:
  - `buf lint` (STANDARD rules) and `buf breaking` (FILE-level) on every PR;
  - field numbers are never reused, and removed fields are `reserved`.
- **TypeScript codegen** with `@bufbuild/protoc-gen-es` (protobuf-es v2), committed under `packages/proto/src/gen/` and exported as `@mindlog/proto`. 64-bit integers are generated as `bigint` (CLAUDE.md rule 4).
- **Python codegen** with `grpcio-tools`, run through `uv run` (PLAN 23.3), committed under `python/mindlog_proto/`.
- A CI check regenerates the code and fails if it differs from the committed output.
- Phase 0 defines only `common.proto` (`Hlc`, `RequestId`, `ErrorDetail`) and the **`Command` envelope** (`request_id = 1`, `principal = 2`, `hlc = 3`, `branch = 4`). Field numbers **10–99 are `reserved`** until each body message lands in its phase, so the PLAN 6.1 numbering cannot be taken by something else.
- Public-facing protocols stay standard: RESP3, REST/JSON, MCP. Protobuf is used for the log, internal RPCs and the public gRPC API only.

## Alternatives considered

- **JSON commands**: readable, but no schema evolution checks, ambiguous 64-bit integers, and larger log entries.
- **Hand-written binary encoding**: smallest, but every change needs custom compatibility code in two languages.
- **FlatBuffers / Cap'n Proto**: zero-copy reads, but weaker Python/TypeScript tooling and gRPC integration than protobuf + buf.

## Consequences

- Generated code is committed, so builds need no network or `protoc`, and diffs in review show API changes.
- `buf breaking` against `main` is skipped until `main` has a proto baseline (the first proto commit), then enforced.
- Command bodies added in later phases must update the `reserved` list in the same commit, and must be gated by cluster version (PLAN 19.5).
- Revisit if log entry size becomes a bottleneck. Compression per entry or batch is a cheaper first step than changing the format.
