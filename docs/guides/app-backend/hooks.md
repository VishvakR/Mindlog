---
description: Server-side TypeScript hooks around record writes, auth and uploads, plus cron jobs.
---

# Hooks and cron

Hooks are TypeScript (or JavaScript) files in `collections.hooksDir`. Each file default-exports a function that receives `app` and registers handlers. Hooks run in a worker thread, isolated from the server's event loop.

{% code title="hooks/todos.ts" %}
```ts
export default function (app) {
  // before: may change the body, or throw to refuse the write
  app.onRecordCreate('todos', 'before', (e) => {
    e.body.title = String(e.body.title ?? '').trim();
    if (e.body.title.length === 0) throw new Error('title is required');
  });

  // after: runs as a durable job once the write is committed
  app.onRecordUpdate('todos', 'after', async (e) => {
    await fetch('http://localhost:9000/webhook', { method: 'POST', body: JSON.stringify(e.body) });
  });

  app.onRecordDelete('todos', 'before', (e) => { /* … */ });
  app.onAuth('users', (e) => { /* runs before sign-in completes; throw to refuse */ });
  app.onFileUpload('todos', (e) => { /* inspect or refuse uploads */ });

  // five UTC cron fields: minute hour day-of-month month day-of-week
  app.cronAdd('nightly-cleanup', '0 3 * * *', async () => { /* … */ });
}
```
{% endcode %}

```yaml
collections:
  hooksDir: ./hooks
```

## Semantics

| Kind | When | Can it change the outcome? |
|---|---|---|
| `before` hooks | Before the write is proposed | Yes: edit `e.body`, or throw to refuse (the client gets the error message) |
| `after` hooks | After the write is committed, as a durable job | No; they are retried like any job |
| `onAuth`, `onFileUpload` | Before sign-in or upload completes | Yes: throw to refuse |
| `cronAdd` | On schedule (`*`, `,`, `-`, `/` supported) | — |

* Each hook call has a **5 s** timeout; each cron run has **60 s**.
* Hooks run on the node handling the request, before proposing, so they may use the clock, randomness and the network. Apply stays deterministic.
* Files ending in `.ts`, `.js` or `.mjs` are loaded, except `.d.ts`. TypeScript must be erasable (types only), because Node strips types at load.
