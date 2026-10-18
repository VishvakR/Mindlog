# syntax=docker/dockerfile:1
# The phase 5 demo agent (python/demo_agents). Build context: python/.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
COPY mindlog_proto ./mindlog_proto
COPY demo_agents ./demo_agents
# model_service is a workspace member; its sources are needed to resolve the workspace, not its models.
COPY model_service/pyproject.toml model_service/README.md ./model_service/
COPY model_service/src ./model_service/src
RUN uv sync --frozen --no-dev --package mindlog-demo-agents
USER nobody
ENTRYPOINT ["/app/.venv/bin/python"]
CMD ["-m", "demo_agents"]
