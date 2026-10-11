# @mindlog/eventbus

In-process typed pub/sub for domain events (PLAN 4.4, layer `core`). It decouples producers such as the state machine and multi-raft from consumers such as cache invalidation, SSE, metrics and view maintenance on the same node.

## Public API

| Export | Purpose |
|---|---|
| `EventBus` | Port: `publish(event)`, `subscribe(type, handler) → unsubscribe` |
| `InMemoryEventBus` | Production implementation; needs a `Logger` and `Metrics` from `@mindlog/core` |
| `DomainEvent`, `DomainEventType`, `EventOf<T>` | Discriminated union of every event, the type names, and narrowing by type |
| `CommandApplied`, `MemoryCommitted`, `ConflictRaised`, `BranchMerged`, `RecordChanged`, `LeaderChanged`, `RangeSplit`, `ModelServiceHealth` | Event shapes from PLAN 4.4 |
| `DOMAIN_EVENT_TYPES` | Every event type, checked for completeness at compile time |

```ts
const bus = new InMemoryEventBus({ logger, metrics });
const off = bus.subscribe('LeaderChanged', (e) => routerCache.invalidate(e.rangeId));
bus.publish({ type: 'LeaderChanged', rangeId: 7n, leader: 'node-2' });
off();
```

## Invariants

- **Events are local facts, emitted after apply.** They are not a replication mechanism and must not drive decisions that replicas need to agree on (CLAUDE.md §3.6). Anything replicated goes through a Raft command instead.
- **Synchronous, ordered delivery.** `publish` calls the handlers subscribed at that moment, in subscription order, before it returns. Handlers added during a dispatch first see the next event.
- **Isolation.** A handler that throws or returns a rejected promise is logged and counted, but never affects the publisher or other handlers. Handlers that do slow work must hand it off (job queue, worker pool) rather than block the publisher.
- **No veto.** Unlike PocketBase hooks there is no `next()`. Extension points that can reject an operation are a separate mechanism that runs before proposing.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_eventbus_events_published_total` | counter | `type` |
| `mindlog_eventbus_handler_errors_total` | counter | `type` |
