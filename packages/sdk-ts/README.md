# @mindlog/sdk

TypeScript client for memory and full-stack mode (PLAN 15, 16): no dependencies, works in browsers and Node; the embedded replica (`@mindlog/sdk/replica`) is Node only.

## Public API

```ts
const m = new MindlogClient('http://localhost:8090', { storage: localStorage });
await m.collection('users').authWithPassword('ann@x.io', 'password123');
await m.collection('todos').create({ title: 'milk', user: m.authStore.record?.id });
const page = await m.collection('todos').getList(1, 20, { filter: 'done = false', sort: '-created' });
const stop = await m.collection('todos').subscribe('*', (e) => console.log(e.action, e.record));
```

- `collection(name)`: `getList`, `getFullList`, `getOne`, `create`, `update` (a `FormData` body uploads files), `delete`, `authWithPassword`, `authRefresh`, `subscribe`.
- `authStore`: `token`, `record`, `isValid`, `save`, `clear`, `onChange`; in memory unless given `storage`.
- `fileUrl`, `getFileToken`, `delegate(apiKey, userToken)`, `subscribe(topic, fn)`, `disconnect`.
- Failures throw `ClientError` with `status`, `code` and per-field `fields`.

### Memory

```ts
const memory = new MemoryApi(client, 'ann', 'mlk_…');
const { ids } = await memory.remember('Ann prefers tea.');
const { items, context } = await memory.recall('what does Ann drink?', { k: 5 });
await memory.forget(ids);
```

- `remember`, `recall`, `get`, `getMany`, `list`, `forget`, `follow(onChange, { signal, from, onState })`.
- Calls are retried on network failures and retryable answers (429, 502–504, `UNAVAILABLE`, `BUSY`); writes carry a `requestId` (generated unless given), so a retry applies once.

### Embedded replica (Node)

```ts
import { EmbeddedReplica } from '@mindlog/sdk/replica';
const replica = EmbeddedReplica.open(client, { path: './.mindlog.db', users: ['ann'], apiKey });
await replica.remember('ann', 'Ann keeps her passport in the blue drawer.');
const hits = await replica.recall('ann', 'passport'); // local, also while offline
```

- A SQLite copy (`node:sqlite`) of the scopes; the same file format as the Python SDK's (ADR-0040).
- `online`, `queued`, `remember`, `forget`, `recall` (BM25, plus vectors when given `embed`), `list`, `settled`, `close`.

## Invariants

- The realtime stream reconnects with backoff, resumes with `Last-Event-ID` and re-sends its subscriptions.
- The replica subscribes before it reads a scope, so no change is missed; changes, snapshots, flushes and its own writes run one at a time.
- Online, a replica's write is stored locally before it returns (read-your-writes). Offline, it is queued with its request id and readable at once under a `local:` id; queued writes replay in order once the stream reconnects, and a write the server refuses for good is dropped and reported to `onRejected`.

## Metrics

None.
