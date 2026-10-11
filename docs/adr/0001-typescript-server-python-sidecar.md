# ADR-0001: TypeScript server with a Python model sidecar

- Status: accepted
- Date: 2026-10-11
- PLAN: 3.2 (processes), 14 (model service), 20.2 (Node.js practices), 23.1–23.2
- References: [node-redis.md](../references/node-redis.md), [letta.md](../references/letta.md), [graphiti.md](../references/graphiti.md), [classic-level.md](../references/classic-level.md)

## Context

Mindlog needs a network server that speaks RESP3, HTTP/SSE, gRPC and MCP; a Raft and storage core; and local ML inference (embeddings, NER, NLI, reranking, small LLM extraction) on CPU with no internet (G6).

- The MCP reference SDK (`@modelcontextprotocol/server` v2) and the PocketBase-style dashboard ecosystem are TypeScript-first. node-redis shows that a fast, fully streaming RESP parser is practical in TypeScript.
- The local-model ecosystem (sentence-transformers, GLiNER, llama-cpp-python, cross-encoders) is Python-first. Graphiti, Mem0, Cognee and A-MEM all run models from Python.
- The project is built by one developer (PLAN assumptions) who needs one primary language and strict typing.
- LevelDB is available to Node through N-API (`classic-level`), with fsync control and snapshots.

## Decision

- The server (adapters, Raft, storage, indexes, memory engine, dashboard host) is **TypeScript on Node.js LTS** (engines `>=24`), ESM, with `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, in a pnpm workspace.
- Models run in a **separate, stateless Python 3.12 process** (`python/model_service`), managed with **uv**, served over gRPC on localhost (port 50051). It has no database access and enforces admission control.
- The server talks to models only through ports (`Embedder`, `Extractor`, `EntityRecognizer`, `NliClassifier`, `Reranker`, `Summarizer`) declared by the consumer. The gRPC client is one adapter.
- Models are called only on the leader, before proposing. Their outputs are embedded in the command (ADR-016), so followers never need the sidecar to apply.

## Alternatives considered

- **All Python**: weaker MCP and dashboard tooling, and an asyncio server with GIL-bound CPU work is a poor fit for a RESP server.
- **All TypeScript, with models via ONNX Runtime / transformers.js**: workable for embeddings, but GLiNER, NLI cross-encoders and grammar-constrained GGUF extraction are much less mature in JS, and the evaluation harness lives in Python anyway.
- **Go or Rust server**: better raw performance, but slower iteration for a solo developer and further from the MCP and dashboard ecosystem. Raw speed is not the primary goal (PLAN 26: "frame correctly").

## Consequences

- Two toolchains (pnpm + uv) and a protobuf contract between them (ADR-0004). CI runs both.
- CPU-heavy work on the Node side must go to `worker_threads` (Piscina) to keep the event loop free (CLAUDE.md §5). The `event_loop_lag` metric is mandatory in benchmarks.
- A model-service outage reduces quality, not availability: the degraded mode (PLAN 21) is a first-class path with tests.
- Revisit if profiling shows the Node data path cannot meet the PLAN 1.5 SLOs even with worker offload.
