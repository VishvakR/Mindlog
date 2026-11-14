---
description: The gRPC API of the Python model service (mindlog.v1.ModelsService).
---

# Model service

The model service is a stateless Python process (`python/model_service`) that runs ONNX models on CPU and serves `mindlog.v1.ModelsService` over gRPC (default `127.0.0.1:50051`). The server calls it only on range leaders, before proposing a command. Followers never call it. Setup is covered in [Run the model service](../getting-started/models.md).

## RPCs

Defined in [`proto/mindlog/v1/models.proto`](https://github.com/VishvakR/Mindlog/blob/main/proto/mindlog/v1/models.proto).

| RPC | Request | Response |
|---|---|---|
| `Embed` | `texts[]`, `kind` (`QUERY` or `PASSAGE`) | `vectors[]` (float32 bytes), `dims` (384), `model_id` |
| `RecognizeEntities` | `texts[]`, `labels[]`, `threshold` | Per text: `spans[]` of `{start, end, text, label, score}`; `model_id` |
| `ClassifyNli` | `pairs[]` of `{premise, hypothesis}` | Per pair: `label` (`ENTAILMENT`, `NEUTRAL`, `CONTRADICTION`) and `score` |
| `Rerank` | `query`, `documents[]` | `scores[]` |
| `ExtractFacts` | `text` | `facts[]` of `{text, kind, relations[] {subject, relation, object}}` |
| `Summarize` | `texts[]`, `instruction`, `max_chars` | `summary` |
| `Health` | — | `ready`, and per capability `{capability, model_id, ready, queue_depth}` |

## Behaviour

* **Micro-batching.** Requests are batched per model, up to `MODEL_BATCH_MAX` (32) items, waiting at most `MODEL_BATCH_WAIT_MS` (5 ms).
* **Admission control.** Each model queues at most `MODEL_QUEUE_MAX` (256) items. Beyond that it answers `RESOURCE_EXHAUSTED`, and the server backs off.
* **Missing models.** A capability whose model is not in `MODELS_DIR` answers `UNAVAILABLE`. The server degrades that capability only.
* **Model ids** are `<directory>@<first 12 characters of the revision>`. Every command records the model that computed its vectors, so a model upgrade triggers re-embedding by consolidation, not silent mixing.
* **No network.** The service sets `HF_HUB_OFFLINE=1` and loads only from `MODELS_DIR`.
* **Health check.** `python -m model_service.health host:port` (used by the Docker image).

## On the server side

The server wraps the client in a **circuit breaker per capability** (`models.breakerFailures`, `models.breakerOpenMs`) and a deadline per call (`models.timeoutMs`). Calls and errors are measured by `mindlog_models_call_latency_seconds` and `mindlog_models_errors_total`.
