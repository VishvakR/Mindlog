# @mindlog/sdk

TypeScript client for full-stack mode (PLAN 15, 16): no dependencies, works in browsers and Node.

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

## Invariants

- The realtime stream reconnects with backoff, resumes with `Last-Event-ID` and re-sends its subscriptions.

## Metrics

None.
