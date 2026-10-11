# mindlog-model-service

Stateless local-inference sidecar (PLAN 14, ADR-0001). It serves embeddings, entity recognition, NLI, reranking and fact extraction over gRPC on localhost, with no database access and with admission control.

Phase 0 contains only the package skeleton. The gRPC API (`proto/models.proto`) and the models arrive in phase 5.

```bash
cd python
uv sync
uv run pytest model_service
uv run mypy model_service
```
