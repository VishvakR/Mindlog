---
description: Follow a scope's memory changes live, and resume after a disconnect without missing anything.
---

# Change streams

Every applied memory command produces change events. A client can follow a scope live and pick up where it left off after a disconnect. That is how dashboards stay current, how agents react to each other's writes, and how [embedded replicas](../embedded-replicas.md) stay in sync.

## Events

| Type | When |
|---|---|
| `memory.added` | New memories were committed |
| `memory.evolved` | Existing memories got a new version (consolidation, trust change, conflict resolution) |
| `memory.forgotten` | Memories were forgotten |
| `conflict.raised`, `conflict.resolved` | A conflict opened or closed |
| `branch.created`, `branch.merged`, `branch.dropped` | Branch lifecycle |
| `resync` | Your cursor is too old; re-read the scope, then continue |

Each event carries a **cursor** `rangeId:index`, the event type, the user, the branch if any, the memory ids, and the principal that caused it.

## Subscribe

{% tabs %}
{% tab title="RESP" %}
```bash
redis-cli -3 -p 6379 MEM.WATCH ana
redis-cli -3 -p 6379 MEM.WATCH ana FROM 3:1842     # resume after a cursor
```

Events arrive as RESP3 push messages on the connection.
{% endtab %}

{% tab title="SSE" %}
```bash
curl -N "localhost:8090/api/realtime?user=ana" -H "Authorization: Bearer $KEY"
```

Reconnects send `Last-Event-ID` (or `from=<cursor>`) to resume.
{% endtab %}

{% tab title="MCP" %}
Subscribe to the resource `memory://{user}/recent`; the host gets `notifications/resources/updated` when it changes.
{% endtab %}

{% tab title="TypeScript" %}
```ts
const ac = new AbortController();
await memory.follow((change) => {
  if (change.type === 'resync') reloadEverything();
  else console.log(change.type, change.ids, change.cursor);
}, { signal: ac.signal, from: savedCursor });
```
{% endtab %}

{% tab title="Python" %}
```python
import threading
stop = threading.Event()
client.memory("ana").follow(lambda c: print(c.type, c.ids, c.cursor), stop, from_cursor=saved)
```
{% endtab %}
{% endtabs %}

## Guarantees

* Events are emitted **after** the command is applied, in log order per range.
* Each range keeps its last 1,000 events. A cursor inside that tail resumes exactly; an older one gets `resync`.
* Events are notifications: they name ids, not contents. Fetch the memories with `getMany`.
