---
description: Live create, update and delete events for records over Server-Sent Events.
---

# Realtime

Clients subscribe to a whole collection or to one record and receive `create`, `update` and `delete` events over Server-Sent Events. Each event is checked against the subscriber's own `listRule` / `viewRule`, so a user only ever sees events for records they may read.

## From the SDK

```ts
const unsubscribe = await pb.collection('todos').subscribe('*', (e) => {
  console.log(e.action, e.record);       // 'create' | 'update' | 'delete'
});
await pb.collection('todos').subscribe(todoId, (e) => …);   // one record
await unsubscribe();
pb.disconnect();                                           // close the stream
```

The SDK reconnects with backoff (up to 10 s), resumes with `Last-Event-ID` and re-sends its subscriptions.

## The protocol

1. `GET /api/realtime` opens the stream. The first event, `PB_CONNECT`, carries a `clientId`.
2. `POST /api/realtime` with `{clientId, subscriptions: ["todos/*", "todos/RECORD_ID"]}` sets the topics. Send the auth token in this request.
3. Events arrive as SSE messages named after the topic, with data `{action, record}`.

This is the same protocol PocketBase uses, so PocketBase-style clients work.

## Memory change streams

The same endpoint carries agent-memory change events when called with `?user=<scope>`. See [Change streams](../memory/change-streams.md).

## Views

[View collections](collections.md#view-collections) are materialized rows, refreshed by jobs, so subscribers to a view get events too.
