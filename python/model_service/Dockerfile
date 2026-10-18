# syntax=docker/dockerfile:1
# Model service sidecar (PLAN 14, ADR-0020). Build context: python/.
# Models baked in at build time: copied from model_service/models/ when they were
# downloaded locally, otherwise fetched once here. The running container never
# downloads anything (HF_HUB_OFFLINE=1) and works with networking disabled.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy MODELS_DIR=/app/model_service/models
COPY pyproject.toml uv.lock ./
COPY mindlog_proto ./mindlog_proto
COPY model_service ./model_service
RUN [ -f "$MODELS_DIR/all-MiniLM-L6-v2/model.onnx" ] \
    || uv run --frozen --package mindlog-model-service --group download \
       python model_service/scripts/download_models.py "$MODELS_DIR"
RUN uv sync --frozen --no-dev --package mindlog-model-service
ENV HF_HUB_OFFLINE=1 MODEL_SERVICE_HOST=0.0.0.0 MODEL_SERVICE_PORT=50051
USER nobody
EXPOSE 50051
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/app/.venv/bin/python", "-m", "model_service.health", "127.0.0.1:50051"]
# The venv python directly: `uv run` needs a writable cache, and nobody has no home.
CMD ["/app/.venv/bin/python", "-m", "model_service"]
