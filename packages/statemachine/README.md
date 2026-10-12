# @mindlog/statemachine

Deterministic command apply, idempotency, and the single-node log behind the `Proposer` port (PLAN 6, layer `replication`). In phase 1 a local log stands in for Raft; phase 3 replaces it behind the same port.

## Public API

| Export | Purpose |
|---|---|
| `Proposer`, `Proposal` | The only write path: `propose(command)` resolves once the command is durable and applied |
| `LocalProposer` | Phase 1 implementation: queue → group commit (one fsync per event-loop turn) → apply in order → resolve. `BUSY` when the queue is full, `UNAVAILABLE` after a failure. `checkpoint()` flushes state, then compacts the log |
| `StateMachine` | `apply(index, command)` in strict index order; `flush()` makes applied state durable; `appliedIndex` |
| `ApplyHandler`, `ApplyContext`, `ApplyHandlerRegistry`, `BodyCase` | One handler per command body (`kvWrite`, `kvBatch`, `expire`, `gcThreshold`, …), registered by the composition root |
| `LocalLog` | Checksummed (CRC-32C), fsynced command log in the log store |
| `recover(log, machine)` | Replays the log above the applied index on startup |
| `IdempotencyTable`, `errorResult`, system key helpers | Stored results per request id; deterministic error results; `$system` key layout |

```ts
const machine = await StateMachine.open({ store: stateStore, handlers, events, clock, logger, metrics });
const log = await LocalLog.open(logStore);
await recover(log, machine);
const proposer = new LocalProposer({ log, machine, logger, metrics });
const proposal = await proposer.propose(command);   // Result<{ index, result }, MindlogError>
```

## Invariants

- **Durable before acknowledged.** A proposal resolves only after its log entry is fsynced and the command is applied (ADR-0005), so kill -9 never loses an acknowledged write.
- **Deterministic apply.** Handlers get the log index, an MVCC transaction, `nowMs` from the command's HLC and `SeededRandom(index)`, and nothing else. Lint bans wall-clock and random globals in this package. Property test: leader, follower and log-rebuilt replica hash identically.
- **One batch per apply.** Handler changes, the idempotency record and the applied index are written together, so state and applied index never disagree.
- **Idempotent.** A request id that was already applied returns its stored result and changes nothing.
- **Fail-stop.** Out-of-order indexes, checksum mismatches, log gaps, state ahead of the log and storage errors throw. The proposer stops for good and never skips an entry. Deterministic validation errors are recorded as results instead.
- **No compaction past durable state** (CLAUDE.md rule 7). `checkpoint()` fsyncs state before compacting the log.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_statemachine_apply_latency_seconds` | histogram | — |
| `mindlog_statemachine_applied_total` | counter | `body` |
| `mindlog_statemachine_proposal_queue_count` | gauge | — |
| `mindlog_statemachine_group_commit_entries` | histogram | — |

Events: `CommandApplied` after every apply.
