# @mindlog/models-client

The memory engine's model ports and their adapters (PLAN 4.3, 14; ADR-0016).

## Public API

- **Ports** (`ports.ts`): `Embedder`, `EntityRecognizer`, `NliClassifier`, `Reranker`, `Extractor`, `Summarizer` (consolidation, PLAN 12.6; texts are quoted data, the instruction is Mindlog's), `ModelHealth`, and `Models` (all of them). Every call returns `Promise<Result<…, MindlogError>>` and takes an optional `{ timeoutMs }`.
- **`GrpcModels`**: the Python model service (`mindlog.v1.ModelsService`) over Connect/gRPC. Status codes map to `UNAVAILABLE`, `BUSY` (queue full), `DEADLINE_EXCEEDED`, `UNIMPLEMENTED` and `INVALID_ARGUMENT`.
- **`GuardedModels`**: wraps any `Models` with a circuit breaker per capability. After `failures` consecutive `UNAVAILABLE`, `DEADLINE_EXCEEDED` or `INTERNAL` errors it fails fast for `openMs`, then lets one probe through. `BUSY` sheds the call but is not counted. `available(capability)` tells the pipeline whether to skip a stage.
- **`FakeModels`**: deterministic stand-ins (hash-bag embeddings, capitalised-word entities, negation NLI, word-overlap rerank, sentence facts, first-sentence summaries) for tests and the simulator. Set `down` or `failWith` to simulate outages.

## Invariants

- Only the node serving a range leader calls models, before proposing (ADR-0016). Apply never imports this package.
- Every result carries the `modelId` (`name@revision`) that produced it.

## Metrics

- `mindlog_models_call_latency_seconds{method}` (histogram)
- `mindlog_models_errors_total{method,code}` (counter)
- `ModelServiceHealth {up}` events when the first breaker opens and when all close again.
