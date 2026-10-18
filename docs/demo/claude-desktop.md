# Mindlog as memory for Claude Desktop (or any MCP host)

Mindlog serves MCP on its own listener (`listen.mcp.http`, default `127.0.0.1:8765/mcp`). A host connects either over Streamable HTTP or by launching `mindlog-server mcp`, a stdio relay to a running node. Everything runs on the machine; no network is needed (ADR-0020).

## 1. Start Mindlog with the model service

```bash
cd python && uv run --package mindlog-model-service --group download python model_service/scripts/download_models.py   # once
uv run python -m model_service &                                       # 127.0.0.1:50051
cd .. && pnpm build
node packages/server/dist/bin.js apikey create --tenant default --user me --name claude-desktop --data-dir ./data
MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051 node packages/server/dist/bin.js --single-node --data-dir ./data
```

The key is printed once. A running node can also create keys through `POST /api/admin/api-keys` (superuser).

## 2. Add Mindlog to the host

In `claude_desktop_config.json` (on macOS: `~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "mindlog": {
      "command": "node",
      "args": [
        "/path/to/Mindlog/packages/server/dist/bin.js",
        "mcp",
        "--url", "http://127.0.0.1:8765/mcp",
        "--api-key", "mlk_…"
      ]
    }
  }
}
```

Hosts that speak Streamable HTTP can use `http://127.0.0.1:8765/mcp` directly, with the header `Authorization: Bearer mlk_…`.

## 3. Try it

- **Session 1:** "Remember that I prefer dark roast coffee, black." The host calls `remember`.
- **Session 2** (a new chat): "What coffee should I order for me?" The host calls `recall` (or uses the `recall-context` prompt) and answers from the packed context.

Tools: `remember`, `recall`, `forget`, `history`, `graph_query`. Resources: `memory://{user}/recent`, `memory://{user}/{id}`. The dashboard at `http://localhost:8090/_/` shows the same memories (Memory, Recall, Graph).
