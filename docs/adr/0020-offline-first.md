# ADR-0020: Offline-first — no network dependency by default

- Status: accepted
- Date: 2026-10-18
- PLAN: 1 (goals), 14.2, 14.6, 24 phase 5 exit gate
- References: [gliner.md](../references/gliner.md)

## Context

Mindlog must run with no internet access: the phase 5 gate runs with the container network disabled except localhost. Model weights are hundreds of megabytes, and the default Hugging Face behaviour downloads into a global user cache on first use.

## Decision

- The model service loads models only from a local directory (`MODELS_DIR`, default `python/model_service/models/` in the repo, `/app/models` in the image). Nothing is downloaded at runtime: `HF_HUB_OFFLINE=1` is set and the service never calls the hub.
- `python/model_service/scripts/download_models.py` is the only downloader. It pins `HF_HOME` and the cache inside `MODELS_DIR`, so no global cache (`~/.cache/huggingface`) is written. The Docker image runs it at build time.
- Defaults are CPU ONNX models with no torch: all-MiniLM-L6-v2 (embeddings), ms-marco-MiniLM-L6-v2 (reranker), nli-deberta-v3-xsmall (NLI), gliner_small-v2.1 int8 (NER). Extraction uses a heuristic splitter unless a local GGUF model is configured (optional llama-cpp extra). Licenses are in `python/model_service/MODELS.md`.
- Remote model adapters (PLAN 14.6) stay opt-in per tenant and are not built in phase 5.
- The compose `offline` profile runs the node and the model service on an `internal: true` network.

## Alternatives considered

- **Download on first use**: fails offline and writes to a global cache.
- **torch-based libraries** (sentence-transformers, gliner): ~2 GB of dependencies for the same models.

## Consequences

- The image is about 0.5 GB larger; `MODELS_DIR` is gitignored.
- Changing a model means re-running the downloader and bumping the model id, which triggers re-embedding later (PLAN 14.5).
