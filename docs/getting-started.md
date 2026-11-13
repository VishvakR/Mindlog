# Getting started

This guide starts one Mindlog node, then uses it as a Redis server, as agent memory over MCP, and from the dashboard. Everything runs locally and offline (ADR-0020).

## 1. Install

You need Node.js 24 or newer with pnpm 10 (`corepack enable`), and [uv](https://docs.astral.sh/uv/) for the Python model service.

```bash
pnpm install
pnpm build
```

## 2. Run a node

```bash
pnpm dev        # mindlog-server --single-node: RESP :6379, HTTP and dashboard :8090, MCP :8765
```

Or with Docker, a node plus the model service, Prometheus, Grafana and Jaeger:

```bash
docker compose --profile dev up
```

The data directory defaults to `./data`. Configuration comes from defaults, then `mindlog.yaml`, then `MINDLOG_<SECTION>__<KEY>` variables, then flags (PLAN Appendix B).

## 3. Use it as Redis

```bash
redis-cli -p 6379 SET greeting hello
redis-cli -p 6379 GET greeting
redis-cli -p 6379 CLUSTER.INFO
```

Supported commands and known differences: [`api/resp-compatibility.md`](api/resp-compatibility.md).

## 4. Add models (optional)

Without models, memory works in degraded mode: raw text, keyword recall. With them, you get extraction, embeddings, entities, conflict detection and rerank.

```bash
cd python
uv run --package mindlog-model-service --group download python model_service/scripts/download_models.py
uv run python -m model_service            # gRPC on 127.0.0.1:50051
```

Start the node with `MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051`.

## 5. Agent memory over MCP

Stop the node. Create an API key, then start the node again:

```bash
node packages/server/dist/bin.js apikey create --tenant acme --user ana --name laptop --data-dir ./data
```

Connect an MCP host to `http://127.0.0.1:8765/mcp` with `Authorization: Bearer mlk_…`. A stdio-only host can launch `mindlog-server mcp --api-key mlk_…` instead.

Tools are listed in [`api/mcp-tools.md`](api/mcp-tools.md). A Claude Desktop walkthrough is in [`demo/claude-desktop.md`](demo/claude-desktop.md). The same memory API is available over RESP (`MEM.*`) and REST (`/api/memory/*`).

## 6. Dashboard

Create a superuser while the node is stopped, then open http://localhost:8090/_/:

```bash
node packages/server/dist/bin.js superuser upsert admin@example.com 'a long password' --data-dir ./data
```

The dashboard has these pages: Overview, Cluster, Memory, Recall, Graph, Conflicts, Branches, Time travel, Live feed, Jobs, Collections, Data, Tenants, Logs & audit, Console, and Settings.

## 7. From code

- TypeScript: [`@mindlog/sdk`](../packages/sdk-ts/README.md), including the embedded offline replica.
- Python: [`mindlog.sdk`](../python/sdk/README.md), with LangGraph store and checkpointer, and CrewAI storage.
- Any Redis client works for KV; the HTTP API is described by [`api/openapi.json`](api/openapi.json).

## Next

- Run a 3-node cluster: `docker compose --profile cluster up`.
- Take backups: set `backup.intervalMs`, or `POST /api/admin/backups`. See [`runbooks/restore-from-backup.md`](runbooks/restore-from-backup.md).
- For production, set `profile: production` with TLS and secrets as files ([`packages/server/README.md`](../packages/server/README.md)).
