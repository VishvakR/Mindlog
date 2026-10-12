# syntax=docker/dockerfile:1
# Model service sidecar (placeholder until phase 5). Build context: python/.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
COPY model_service ./model_service
COPY mindlog_proto ./mindlog_proto
RUN uv sync --frozen --no-dev --package mindlog-model-service
USER nobody
EXPOSE 50051
CMD ["uv", "run", "--no-sync", "python", "-m", "model_service"]
