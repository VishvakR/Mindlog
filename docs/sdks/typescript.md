---
description: The @mindlog/sdk package for browsers and Node; records, auth, files, realtime, agent memory and embedded replicas.
---

# TypeScript SDK

`@mindlog/sdk` is a dependency-free TypeScript client for the HTTP API. It runs in browsers and Node 24+. The embedded replica (`@mindlog/sdk/replica`) needs Node, because it uses the built-in `node:sqlite`.

## Install

The package is not published to npm yet. Use it from the workspace, or from the tarball attached to each GitHub release:

{% tabs %}
{% tab title="In this repo" %}
```json
{ "dependencies": { "@mindlog/sdk": "workspace:*" } }
```
{% endtab %}

{% tab title="Release tarball" %}
```bash
npm install ./mindlog-sdk-1.0.0.tgz
```
{% endtab %}
{% endtabs %}

| Entry point | Exports |
|---|---|
| `@mindlog/sdk` | `MindlogClient`, `RecordService`, `AuthStore`, `MemoryApi`, `ClientError`, `isRetryable`, and the types below |
| `@mindlog/sdk/replica` | `EmbeddedReplica`, `ReplicaOptions`, `LocalHit` |

## `MindlogClient`

```ts
import { MindlogClient } from '@mindlog/sdk';

const client = new MindlogClient('http://localhost:8090', {
  tenant: 'acme',             // sent as X-Mindlog-Tenant (optional)
  storage: localStorage,      // persist the auth session (optional; memory by default)
});
```

| Member | Description |
|---|---|
| `authStore: AuthStore` | The current session: token, refresh token, record |
| `collection(name): RecordService` | Records of one collection |
| `send<T>(path, { method?, body?, token? }): Promise<T>` | Any API call. `FormData` goes as multipart, anything else as JSON. 204 returns `undefined`; non-2xx throws `ClientError` |
| `url(path)`, `authHeaders(token?)` | Build a URL; the `Authorization` header for a token |
| `fileUrl(record, filename, { thumb?, token?, collection? })` | URL of an uploaded file |
| `getFileToken(): Promise<string>` | A short-lived token for protected files |
| `delegate(apiKey, userToken): Promise<string>` | A token for an agent acting as a user ([delegation](../guides/app-backend/authentication.md#delegating-to-an-agent)) |
| `subscribe(topic, listener): Promise<() => Promise<void>>` | Realtime events for `'coll/*'` or `'coll/id'`; returns an unsubscribe function |
| `disconnect()` | Close the realtime stream |

## `RecordService`

```ts
const todos = client.collection('todos');

const page = await todos.getList(1, 30, { filter: 'done = false', sort: '-created', expand: 'user' });
const all  = await todos.getFullList({ filter: "user = 'abc'" });        // pages of 500
const one  = await todos.getOne(id, { fields: 'id,title' });
const made = await todos.create({ title: 'milk', user: userId });       // or FormData with files
await todos.update(id, { done: true, 'tags+': 'urgent' });
await todos.delete(id);
const stop = await todos.subscribe('*', (e) => console.log(e.action, e.record));
```

| Method | Returns |
|---|---|
| `getList<T>(page = 1, perPage = 30, query?)` | `ListResult<T>`: `{page, perPage, totalItems, totalPages, items}` |
| `getFullList<T>(query?)` | `T[]` |
| `getOne<T>(id, { expand?, fields? })` | `T` |
| `create<T>(body \| FormData)`, `update<T>(id, body \| FormData)` | `T` |
| `delete(id)` | `void` |
| `authWithPassword(identity, password)` | `{token, refreshToken?, record}`, saved into `authStore` |
| `authRefresh()` | The same; uses the refresh token when there is one |
| `subscribe(id \| '*', listener)` | An unsubscribe function |

`RecordQuery` is `{ filter?, sort?, expand?, fields?, skipTotal? }`; `RealtimeEvent<T>` is `{ action: 'create' | 'update' | 'delete', record: T }`.

## `AuthStore`

| Member | Description |
|---|---|
| `token`, `refreshToken`, `record` | The session |
| `isValid` | True when the token exists and its JWT `exp` is in the future |
| `save(token, record, refreshToken?)`, `clear()` | Change the session |
| `onChange(listener): () => void` | Listen for changes; returns an unsubscribe function |

With a `storage` (any `{getItem, setItem, removeItem}`, such as `localStorage`), the session is kept under the key `mindlog_auth`.

## `MemoryApi`

```ts
import { MemoryApi } from '@mindlog/sdk';

const memory = new MemoryApi(client, 'ana', 'mlk_…');      // client, user scope, API key

const { ids, memories, degraded } = await memory.remember('Ana prefers tea.', { tags: ['prefs'] });
const { items, context } = await memory.recall('what does Ana drink?', { k: 5, recipe: 'hybrid', tokenBudget: 600 });
const m = await memory.get(ids[0]);                        // Memory | null
const many = await memory.getMany(ids);                    // batches of 100
const { memories: page, next } = await memory.list({ limit: 50 });
await memory.forget(ids, { reason: 'user asked' });
```

| Method | Description |
|---|---|
| `remember(content, { kind?, tags?, meta?, requestId? })` | Returns `{ids, memories, degraded}`. A `requestId` is generated if you don't pass one |
| `recall(query, { k?, recipe?, tokenBudget? })` | Returns `Recalled`: `{items: RecallHit[], context, degraded}` |
| `get(id)`, `getMany(ids)` | Read memories |
| `list({ limit?, after? })` | `{memories, next?}`, oldest first |
| `forget(ids, { reason?, requestId? })` | `{ids, count}` |
| `follow(onChange, { signal, from?, onState? })` | Follow the scope's [change stream](../guides/memory/change-streams.md); resolves when `signal` aborts. A change of type `resync` means "re-read the scope" |

Calls retry 5 times with backoff (100 ms × 2ⁿ) on network failures and on retryable answers. Writes always carry a request id, so a retry applies once.

## Errors

```ts
import { ClientError, isRetryable } from '@mindlog/sdk';

try {
  await client.collection('todos').create({});
} catch (e) {
  if (e instanceof ClientError) console.log(e.status, e.code, e.fields);  // 400 INVALID_ARGUMENT { title: 'required' }
  if (isRetryable(e)) { /* 429, 502–504, UNAVAILABLE, BUSY, RATE_LIMITED, NOT_LEADER, network */ }
}
```

`ClientError` is built from the server's RFC 9457 problem details (`status`, `code`, `message`, per-field `fields`). See [Errors](../reference/errors.md).

## Embedded replica

```ts
import { EmbeddedReplica } from '@mindlog/sdk/replica';

const replica = EmbeddedReplica.open(client, { path: './.mindlog.db', users: ['ana'], apiKey: 'mlk_…' });
await replica.remember('ana', 'Passport is in the blue drawer.');   // {ids, queued}
const hits = await replica.recall('ana', 'passport', 5);           // LocalHit[]: id, text, kind, score, pending
```

| `ReplicaOptions` | |
|---|---|
| `path` | SQLite file |
| `users` | User scopes to follow |
| `apiKey` | API key for the server |
| `embed?: (texts) => Promise<Float32Array[]>` | Adds vector search to local recall |
| `onRejected?: (op, error) => void` | Called when the server refuses a queued write for good |

Members: `online`, `queued`, `remember`, `forget`, `recall`, `list`, `settled()`, `close()`. A user the replica does not follow throws `RangeError`. How syncing works is described in [Embedded replicas](../guides/embedded-replicas.md).
