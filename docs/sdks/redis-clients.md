---
description: Use any Redis client with Mindlog, including the MEM.* and CACHE.* commands.
---

# Redis clients

Mindlog speaks RESP2 and RESP3, so standard Redis clients connect to `:6379` unchanged. Mindlog's own commands (`MEM.*`, `CACHE.*`, `CLUSTER.*`) are sent with the client's generic command call.

{% tabs %}
{% tab title="redis-cli" %}
```bash
redis-cli -p 6379 -3                     # RESP3
127.0.0.1:6379> AUTH mlk_…
127.0.0.1:6379> SET greeting hello
127.0.0.1:6379> MEM.ADD ana "Ana prefers dark roast coffee."
127.0.0.1:6379> MEM.SEARCH ana "coffee" K 3 RECIPE hybrid
```
{% endtab %}

{% tab title="ioredis" %}
```ts
import Redis from 'ioredis';

const redis = new Redis({ port: 6379, password: 'mlk_…' });   // AUTH with an API key
await redis.set('greeting', 'hello');
await redis.call('MEM.ADD', 'ana', 'Ana prefers dark roast coffee.');
const hits = await redis.call('MEM.SEARCH', 'ana', 'coffee', 'K', '3');
```
{% endtab %}

{% tab title="node-redis" %}
```ts
import { createClient } from 'redis';

const client = createClient({ url: 'redis://localhost:6379', password: 'mlk_…', RESP: 3 });
await client.connect();
await client.sendCommand(['MEM.ADD', 'ana', 'Ana prefers dark roast coffee.']);
const packed = await client.sendCommand(['MEM.PACK', 'ana', 'coffee', 'BUDGET', '300']);
```
{% endtab %}

{% tab title="redis-py" %}
```python
import redis

r = redis.Redis(port=6379, password="mlk_…", protocol=3, decode_responses=True)
r.set("greeting", "hello")
r.execute_command("MEM.ADD", "ana", "Ana prefers dark roast coffee.")
hits = r.execute_command("MEM.SEARCH", "ana", "coffee", "K", 3)
```
{% endtab %}
{% endtabs %}

## Tips

* **Use RESP3** (`HELLO 3`, or the client's protocol option). `MEM.*` replies are maps, which RESP3 keeps as maps; RESP2 flattens them into arrays of alternating keys and values.
* **Retry** `-BUSY` and `-TRYAGAIN` with backoff. Most clients have a retry strategy option.
* **One endpoint is enough.** Any node accepts any key and forwards to the right range leader, so don't use Redis Cluster mode; cluster-aware clients would look for `CLUSTER SLOTS`, which Mindlog does not implement.
* **Transactions** (`MULTI`/`EXEC`, pipelines with `WATCH`) work as in Redis, within one range.
* Compatibility is tested with ioredis and redis-py (RESP2 and RESP3) on every CI run. The [RESP commands](../api/resp-compatibility.md) page lists every supported command and difference.
