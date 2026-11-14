---
description: The mindlog Python package (mindlog.sdk); memory, KV, change streams and embedded replicas, standard library only.
---

# Python SDK

The `mindlog` distribution provides `mindlog.sdk`, a synchronous client for Python 3.12+ that uses only the standard library. Optional adapters plug Mindlog into [LangGraph](langgraph.md) and [CrewAI](crewai.md).

## Install

{% tabs %}
{% tab title="From this repo (uv)" %}
```bash
cd python
uv sync                       # the workspace includes python/sdk
uv sync --extra langgraph     # with the LangGraph adapter
```
{% endtab %}

{% tab title="Release wheel" %}
```bash
uv pip install ./mindlog-1.0.0-py3-none-any.whl
uv pip install "./mindlog-1.0.0-py3-none-any.whl[langgraph]"
```
{% endtab %}
{% endtabs %}

The module is `mindlog.sdk` because `mindlog` is a namespace shared with the generated `mindlog.v1` protobuf code.

```python
from mindlog.sdk import Client, ClientError, EmbeddedReplica, MemoryApi, Change, LocalHit, retryable
```

## `Client`

```python
client = Client("http://localhost:8090", api_key="mlk_…", tenant=None, timeout=30)
```

| Member | Description |
|---|---|
| `memory(user) -> MemoryApi` | Memory of one user scope |
| `send(method, path, body=None)` | Any API call, with 5 retries on retryable failures |
| `headers()` | The headers sent with each request |
| `kv_get(key)` | A JSON value, or `None` if the key is missing |
| `kv_put(key, value)` | Store a JSON value |
| `kv_delete(key)` | Delete (a missing key is not an error) |
| `kv_scan(match) -> Iterator[str]` | Iterate key names matching a glob |

{% hint style="info" %}
The `kv_*` methods need a key whose role allows KV access (`developer` or `tenant_admin`). The default `agent` role may only use memory and gets `PERMISSION_DENIED`.
{% endhint %}

## `MemoryApi`

```python
memory = client.memory("ana")

res = memory.remember("Ana prefers tea.", tags=["prefs"], meta={"channel": "chat"})
ids = res["ids"]
hits = memory.recall("what does Ana drink?", k=5, recipe="hybrid")
print(hits["context"])
memory.get(ids[0])
memory.get_many(ids)
memory.list(limit=200, after=None)
memory.forget(ids, reason="user asked")
```

| Method | Description |
|---|---|
| `remember(content, *, kind=None, tags=None, meta=None, request_id=None)` | Store; returns the raw response dict (`ids`, `memories`, `degraded`) |
| `recall(query, k=10, recipe=None)` | Recall; returns `items`, `context`, `degraded`, … (no token-budget option, unlike the TypeScript SDK) |
| `get(memory_id)`, `get_many(ids)` | Read |
| `list(limit=200, after=None)` | Page through the scope, oldest first |
| `forget(ids, reason=None, request_id=None)` | Forget (append-only) |
| `follow(on_change, stop, from_cursor=None, on_state=None)` | Follow the change stream on the calling thread until `stop` (a `threading.Event`) is set. `on_change` receives `Change(type, cursor, ids)` |

Writes carry a request id (generated if not given), so retries apply once.

## Errors

```python
try:
    client.memory("ana").recall("")
except ClientError as e:
    print(e.status, e.code, e.message, e.fields)   # status 0 means the server was not reached
    if retryable(e):
        ...
```

`retryable(e)` is true for status 0, 429, 502–504, the codes `UNAVAILABLE`, `BUSY`, `RATE_LIMITED` and `NOT_LEADER`, and for `OSError` and timeouts.

## Embedded replica

```python
replica = EmbeddedReplica(client, "./.mindlog.db", ["ana"], embed=None, on_rejected=None)
ids, queued = replica.remember("ana", "Passport is in the blue drawer.", kind=None, tags=None)
for hit in replica.recall("ana", "passport", k=10):      # LocalHit(id, text, kind, score, pending)
    print(hit.score, hit.text, "(pending)" if hit.pending else "")
replica.settled(); replica.close()
```

The constructor starts one background thread per followed user. `online` and `queued` report the sync state, and a user the replica does not follow raises `KeyError`. The file format is shared with the TypeScript replica. See [Embedded replicas](../guides/embedded-replicas.md).

## Examples in the repository

| Path | Shows |
|---|---|
| [`python/demo_agents`](https://github.com/VishvakR/Mindlog/tree/main/python/demo_agents) | Two-session memory over MCP (`uv run python -m demo_agents`) and the multi-agent conflict, branch and time-travel demo (`python -m demo_agents.phase7`) |
| [`python/compat`](https://github.com/VishvakR/Mindlog/tree/main/python/compat) | redis-py compatibility tests over RESP2 and RESP3 |
| [`python/evals`](https://github.com/VishvakR/Mindlog/tree/main/python/evals) | The LongMemEval and LoCoMo evaluation harness |
