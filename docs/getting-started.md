---
description: Run one node and use it as Redis, as agent memory and from the dashboard, in about ten minutes.
---

# Quickstart

This guide starts one Mindlog node, then uses it three ways: as a Redis server, as memory for an agent, and from the dashboard. Everything runs locally and offline. You need the [installation](getting-started/installation.md) done (`pnpm install && pnpm build`).

{% hint style="info" %}
`mindlog-server` below means `node packages/server/dist/bin.js`. Commands that write accounts or keys (`superuser`, `apikey`) open the data directory directly, so run them **while the node is stopped**.
{% endhint %}

## 1. Create an account and an API key

```bash
mindlog-server superuser upsert admin@example.com 'a long password' --data-dir ./data
mindlog-server apikey create --tenant default --user ana --name laptop --data-dir ./data
```

```
API key id 0a1b2c3d4e5f6071 for tenant default, user ana:
mlk_EXAMPLEdoNotUseThisKeyXXXXXXXXXXXXXXXXXXXX
Store it now; it is not shown again.
```

The superuser signs in to the dashboard and admin APIs. The API key is what an agent or app uses. It belongs to tenant `default` and is pinned to the user scope `ana`.

## 2. Start the node

```bash
mindlog-server --single-node --data-dir ./data
```

| Listener | Address |
|---|---|
| RESP (Redis protocol) | `0.0.0.0:6379` |
| HTTP: REST, SSE, dashboard, metrics | `0.0.0.0:8090` |
| MCP (Streamable HTTP) | `127.0.0.1:8765/mcp` |

The node logs `no model service configured`: memory runs in [degraded mode](guides/memory/remember.md#degraded-mode) until you [add the model service](getting-started/models.md). Everything below works either way.

## 3. Use it as Redis

Any Redis client works. With `redis-cli`:

```bash
redis-cli -p 6379 SET greeting hello        # OK
redis-cli -p 6379 GET greeting              # "hello"
redis-cli -p 6379 HSET user:1 name Ana plan pro
redis-cli -p 6379 EXPIRE greeting 60
redis-cli -p 6379 CLUSTER.INFO              # Raft role, term, leader, indexes
```

The supported commands and the small differences from Redis are listed in [RESP commands](api/resp-compatibility.md).

## 4. Give an agent a memory

Store a few facts, then ask for them back. The same operation is shown in each interface:

{% tabs %}
{% tab title="RESP" %}
```bash
redis-cli -p 6379 MEM.ADD ana "Ana prefers dark roast coffee, black. She is allergic to peanuts."
redis-cli -p 6379 MEM.SEARCH ana "what coffee does Ana like?" K 3
redis-cli -3 -p 6379 MEM.PACK ana "coffee" BUDGET 200
```

```
context  ## Recent episodes
         - Ana prefers dark roast coffee, black. She is allergic to peanuts.
tokens   22
budget   200
```
{% endtab %}

{% tab title="REST" %}
```bash
KEY=mlk_…
curl -s localhost:8090/api/memory/remember \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"scope":{"user":"ana"},"content":"Ana is planning a trip to Lisbon in May."}'

curl -s localhost:8090/api/memory/recall \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"scope":{"user":"ana"},"query":"Where is Ana travelling?","k":3}'
```

The recall response holds the ranked `items` (each memory with its `score` and the `signals` behind it), and `context`, a packed text block ready to put in a prompt.
{% endtab %}

{% tab title="TypeScript" %}
```ts
import { MindlogClient, MemoryApi } from '@mindlog/sdk';

const client = new MindlogClient('http://localhost:8090');
const memory = new MemoryApi(client, 'ana', process.env.MINDLOG_API_KEY);

await memory.remember('Ana is planning a trip to Lisbon in May.');
const { items, context } = await memory.recall('Where is Ana travelling?', { k: 3 });
```
{% endtab %}

{% tab title="Python" %}
```python
from mindlog.sdk import Client

client = Client("http://localhost:8090", api_key="mlk_…")
memory = client.memory("ana")
memory.remember("Ana is planning a trip to Lisbon in May.")
hits = memory.recall("Where is Ana travelling?", k=3)["items"]
```
{% endtab %}
{% endtabs %}

{% hint style="info" %}
Over RESP without `AUTH`, requests act in tenant `default` as an anonymous principal. Send `AUTH mlk_…` first to act as the key. That is required once [tenants and access control](guides/tenants-and-access.md) are in use.
{% endhint %}

## 5. Connect an MCP host

Point any MCP host at `http://127.0.0.1:8765/mcp` with the header `Authorization: Bearer mlk_…`. Hosts that only speak stdio launch the bundled relay instead:

```bash
mindlog-server mcp --api-key mlk_…
```

The full setup for Claude Desktop and Claude Code is in [Connect an AI agent](getting-started/connect-an-agent.md).

## 6. Open the dashboard

Open [http://localhost:8090/\_/](http://localhost:8090/_/) and sign in as `admin@example.com`. The **Memory**, **Recall** and **Graph** pages show what you just stored; **Console** runs Redis commands in the browser. See [Dashboard](guides/dashboard.md) for a tour.

## Next steps

* [Run the model service](getting-started/models.md) for extraction, embeddings and conflict detection.
* Learn how [remembering](guides/memory/remember.md) and [recall](guides/memory/recall.md) work.
* Run a [three-node cluster](getting-started/deployment.md).
* Build an app with [collections](guides/app-backend/README.md).
