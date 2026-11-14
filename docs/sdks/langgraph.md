---
description: Use Mindlog as LangGraph's long-term store (with semantic search) and as its checkpointer.
---

# LangGraph

`mindlog.sdk.langgraph` provides two LangGraph integrations:

| Class | LangGraph interface | Backed by |
|---|---|---|
| `MindlogStore` | `BaseStore` (long-term memory: `put`, `get`, `search`, `list_namespaces`) | Mindlog KV, plus agent memory for semantic search |
| `MindlogCheckpointer` | `BaseCheckpointSaver` (thread state) | Mindlog KV |

Install the extra: `uv sync --extra langgraph` (or `mindlog[langgraph]`, which needs `langgraph>=0.4`).

{% hint style="info" %}
Both classes write KV keys, so the client's API key needs the `developer` role, not the default `agent` role. Create one through the [tenant API](../guides/tenants-and-access.md#api-keys) with `"role": "developer"`.
{% endhint %}

## Store

```python
from mindlog.sdk import Client
from mindlog.sdk.langgraph import MindlogStore

client = Client("http://localhost:8090", api_key="mlk_…")
store = MindlogStore(client, user="langgraph")

store.put(("users", "ana"), "prefs", {"coffee": "dark roast, black"})
store.get(("users", "ana"), "prefs").value
store.search(("users", "ana"), query="what does she drink?")   # Mindlog recall
```

* Items are stored as KV keys `lg:store:<hex namespace>:<hex key>`.
* Unless `index=False`, `put` also writes a `semantic` memory to the store's user scope, and `search(query=…)` runs Mindlog [recall](../guides/memory/recall.md) over it.
* `search` without a query scans the namespace and sorts by `updated_at`, newest first. That scan is meant for small namespaces, up to a few thousand items.
* Async variants (`abatch` and the methods built on it) run the sync calls in a thread.

Use it in a graph:

```python
from langgraph.graph import StateGraph

graph = StateGraph(State)
# … nodes and edges …
app = graph.compile(store=store)
```

## Checkpointer

```python
from mindlog.sdk.langgraph import MindlogCheckpointer

checkpointer = MindlogCheckpointer(client)
app = graph.compile(checkpointer=checkpointer, store=store)
app.invoke(inputs, {"configurable": {"thread_id": "ana-trip"}})
```

It implements `get_tuple`, `list(config, *, filter, before, limit)`, `put`, `put_writes`, `delete_thread`, their async variants, and `get_next_version`. Checkpoints are replicated through Raft like any KV write, so a thread survives the loss of a node.
