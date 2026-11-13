# mindlog (Python SDK)

Python client for Mindlog memory (PLAN 15.5), standard library only, as `mindlog.sdk`.

```python
from mindlog.sdk import Client, EmbeddedReplica

client = Client("http://localhost:8090", api_key="mlk_…")
memory = client.memory("ann")
ids = memory.remember("Ann prefers tea.")["ids"]
hits = memory.recall("what does Ann drink?", k=5)["items"]

replica = EmbeddedReplica(client, "./.mindlog.db", ["ann"])
replica.recall("ann", "tea")  # local, also while the server is unreachable
```

- `Client`: `memory(user)`, `send`, `kv_get` / `kv_put` / `kv_delete` / `kv_scan` (JSON values).
- `MemoryApi`: `remember`, `recall`, `get`, `get_many`, `list`, `forget`, `follow`. Calls are retried on network failures and retryable answers; writes carry a request id, so a retry applies once.
- `EmbeddedReplica`: a SQLite copy of user scopes in the same format as the TypeScript SDK's (ADR-0040): `online`, `queued`, `remember`, `forget`, `recall` (BM25, plus vectors with `embed`), `list`, `settled`, `close`. Writes made offline are queued and readable at once, then replayed in order.
- `mindlog.sdk.langgraph` (extra `langgraph`): `MindlogStore` (LangGraph `BaseStore`; `search(query=…)` is Mindlog recall) and `MindlogCheckpointer` (`BaseCheckpointSaver` on KV).
- `mindlog.sdk.crewai`: `MindlogCrewStorage`, CrewAI's memory `Storage` (`save`, `search`, `reset`) without importing CrewAI.

The module is `mindlog.sdk` because `mindlog` is a namespace shared with the generated `mindlog.v1` protobuf code.

Tests (`pytest -m integration`) start a node from `packages/server/dist` (run `pnpm build` first) behind a proxy that can cut the network, and run the shared scenario in `test/scenarios/replica-offline.json`.
