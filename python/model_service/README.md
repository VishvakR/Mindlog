# mindlog-model-service

Stateless local-inference sidecar (PLAN 14, ADR-0001, ADR-0016, ADR-0020). It serves `mindlog.v1.ModelsService` (`proto/mindlog/v1/models.proto`) over gRPC: embeddings, zero-shot entity recognition (GLiNER), NLI, reranking and fact extraction. It has no database access, and it runs fully offline.

## Run

```bash
cd python
uv run --package mindlog-model-service --group download python model_service/scripts/download_models.py   # once, ~450 MB into model_service/models/
uv run python -m model_service          # listens on 127.0.0.1:50051
```

Models load only from `MODELS_DIR` (default `python/model_service/models/`). The downloader keeps Hugging Face's cache inside that directory too, so nothing is written to `~/.cache`. See [MODELS.md](MODELS.md) for the models and their licenses.

| Variable | Default | Meaning |
|---|---|---|
| `MODELS_DIR` | `python/model_service/models` | Where the models are |
| `MODEL_SERVICE_HOST` / `MODEL_SERVICE_PORT` | `127.0.0.1` / `50051` | Listen address (`0` picks a free port) |
| `MODEL_BATCH_MAX` / `MODEL_BATCH_WAIT_MS` | `32` / `5` | Micro-batch size and wait |
| `MODEL_QUEUE_MAX` | `256` | Items queued per model before `RESOURCE_EXHAUSTED` |
| `EXTRACT_GGUF` | unset | A local GGUF model for LLM extraction (needs `--extra llm`); the heuristic splitter otherwise |

## Design

- One `MicroBatcher` per model collects requests for up to 5 ms or 32 items and runs one forward pass in a thread, off the event loop. Extraction has its own single thread, so a long generation never blocks embeddings.
- **Admission control:** a full queue answers `RESOURCE_EXHAUSTED` at once. A capability whose model is missing answers `UNAVAILABLE`. The server's circuit breaker then switches to degraded mode (PLAN 21).
- **Warm-up:** each model runs once before the port opens. `Health` lists every capability, its model id and its queue depth. The container healthcheck is `python -m model_service.health host:port`.
- **GLiNER** runs as ONNX, with the prompt, word-mask and span decoding written here (`gliner.py`, docs in `docs/references/gliner.md`).

## Test

```bash
uv run pytest model_service           # fast tests use fake backends; real-model tests skip until models are downloaded
uv run pytest model_service -m integration
uv run ruff check && uv run mypy model_service
```
