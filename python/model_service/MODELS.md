# Models

The defaults (PLAN 14.2, ADR-0020) are small CPU models run on ONNX Runtime, with no torch. `scripts/download_models.py` fetches them at the pinned revisions into `models/` (gitignored). The service loads only from there (`MODELS_DIR`) and never downloads at runtime.

| Capability | Directory | Source (revision) | File | Size | License |
|---|---|---|---|---|---|
| Embeddings (384-d) | `all-MiniLM-L6-v2` | [sentence-transformers/all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) (`1110a243`) | `onnx/model.onnx` | 87 MB | Apache-2.0 |
| Reranker | `ms-marco-MiniLM-L6-v2` | [cross-encoder/ms-marco-MiniLM-L6-v2](https://huggingface.co/cross-encoder/ms-marco-MiniLM-L6-v2) (`233902d2`) | `onnx/model.onnx` | 87 MB | Apache-2.0 |
| NLI | `nli-deberta-v3-xsmall` | [cross-encoder/nli-deberta-v3-xsmall](https://huggingface.co/cross-encoder/nli-deberta-v3-xsmall) (`a1508764`) | `onnx/model_qint8_arm64.onnx` (arm64) or `onnx/model_quint8_avx2.onnx` (x86-64) | 92 MB | Apache-2.0 |
| Entities (zero-shot) | `gliner_small-v2.1` | [onnx-community/gliner_small-v2.1](https://huggingface.co/onnx-community/gliner_small-v2.1) (`8142fb00`), ONNX export of [urchade/gliner_small-v2.1](https://huggingface.co/urchade/gliner_small-v2.1) | `onnx/model_int8.onnx` | 183 MB | Apache-2.0 |
| Fact extraction | — | heuristic sentence splitter (`heuristic-sentences@1`) | — | — | this repo |
| Fact extraction (optional) | any GGUF instruct model (`EXTRACT_GGUF=/path/model.gguf`, `uv sync --extra llm`) | chosen by the operator | — | 1–3 GB | check the model's license before use |

Model ids in responses are `<directory>@<first 12 characters of the revision>` (from `manifest.json`), so a command records exactly which model computed its vectors (PLAN 14.5).
