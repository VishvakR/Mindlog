---
description: Give Claude Desktop, Claude Code or any MCP host a long-term memory backed by Mindlog.
---

# Connect an AI agent (MCP)

Mindlog serves the [Model Context Protocol](https://modelcontextprotocol.io) on its own listener, `listen.mcp.http` (default `127.0.0.1:8765/mcp`, Streamable HTTP). Hosts that only speak stdio launch `mindlog-server mcp`, a relay to a running node. Every MCP request carries an API key, which decides the tenant, the default user scope and what the agent may do.

## 1. Create an API key

With the node **stopped**:

```bash
mindlog-server apikey create --tenant default --user me --name claude-desktop --data-dir ./data
```

The key (`mlk_…`) is printed once. On a running node, a superuser can create keys from the dashboard (**Tenants → Keys**) or with `POST /api/admin/api-keys`. Keys default to the `agent` role, which may read and write memory and nothing else. See [Tenants and access control](../guides/tenants-and-access.md).

## 2. Start Mindlog (with models for full quality)

```bash
# once: download the local models (~450 MB) into python/model_service/models/
cd python && uv run --package mindlog-model-service --group download python model_service/scripts/download_models.py
uv run python -m model_service &                     # gRPC on 127.0.0.1:50051
cd .. && MINDLOG_MODELS__ENDPOINT=127.0.0.1:50051 mindlog-server --single-node --data-dir ./data
```

Without the model service, memory still works in degraded mode (see [Run the model service](models.md)).

## 3. Add Mindlog to your host

{% tabs %}
{% tab title="Claude Desktop" %}
Edit `claude_desktop_config.json` (on macOS in `~/Library/Application Support/Claude/`):

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

Restart Claude Desktop. The relay forwards stdio to the running node.
{% endtab %}

{% tab title="Claude Code" %}
```bash
claude mcp add --transport http mindlog http://127.0.0.1:8765/mcp \
  --header "Authorization: Bearer mlk_…"
```
{% endtab %}

{% tab title="Any Streamable HTTP host" %}
| Setting | Value |
|---|---|
| URL | `http://127.0.0.1:8765/mcp` |
| Header | `Authorization: Bearer mlk_…` |
{% endtab %}

{% tab title="Any stdio host" %}
```bash
mindlog-server mcp --api-key mlk_… --url http://127.0.0.1:8765/mcp
```

`MINDLOG_API_KEY` and `MINDLOG_MCP_URL` can replace the flags.
{% endtab %}
{% endtabs %}

## 4. Try it

* **Session 1:** "Remember that I prefer dark roast coffee, black." The host calls `remember`.
* **Session 2** (a new chat): "What coffee should I order for me?" The host calls `recall`, or uses the `recall-context` prompt, and answers from the packed context.

Open the dashboard (**Memory**, **Recall**, **Graph**) to see what the agent stored.

## What the agent gets

| Tools | Purpose |
|---|---|
| `remember`, `remember_tool_call` | Store facts, preferences, decisions and tool outcomes |
| `recall` | Hybrid search packed into a token budget |
| `forget`, `history`, `graph_query` | Remove (append-only), inspect versions, walk the entity graph |
| `cache_lookup`, `cache_store` | Semantic answer cache tied to the memories it used |
| `conflicts`, `resolve_conflict` | Review contradictions |
| `branch_create`, `branch_diff`, `branch_merge`, `branch_drop` | Try plans on an isolated memory branch |

| Resources and prompts | |
|---|---|
| `memory://{user}/recent` | The 20 newest memories; subscribable for live updates |
| `memory://{user}/{id}` | One memory |
| `recall-context` prompt | Recalls memory for a task and frames it as quoted context |

Inputs, outputs and errors for each tool are in the [MCP tool reference](../api/mcp-tools.md).

## Serving MCP beyond localhost

The MCP listener binds `127.0.0.1` by default, which protects against DNS-rebinding attacks. To serve other machines, bind another address and list the host names clients will use, and turn on TLS:

```yaml
listen:
  mcp:
    http:
      host: 0.0.0.0
      allowedHosts: ['mindlog.internal.example.com']
tls:
  enabled: true
  cert: /etc/mindlog/tls/node.crt
  key: /etc/mindlog/tls/node.key
  ca: /etc/mindlog/tls/ca.crt
```

{% hint style="warning" %}
Recalled memories are data from past sessions, not instructions. Mindlog quarantines content from untrusted sources (`web`, unlisted tools and domains) and leaves it out of recall by default. See [Trust and provenance](../guides/memory/trust.md).
{% endhint %}
