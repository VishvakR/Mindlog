# @mindlog/statemachine

Deterministic command apply, idempotency, the Raft log store and state snapshots (PLAN 6, ADR-0026, layer `replication`). The range replica in `@mindlog/multiraft` drives it.

## Public API

| Export | Purpose |
|---|---|
| `Proposer`, `Proposal` | The only write path: `propose(command)` resolves once the command is committed and applied (implemented by `Replica`) |
| `StateMachine` | One per range. `apply(index, term, command)` in strict index order. `applyEmpty` for the leader's no-op, `applyConfState` for membership changes (bumps `epoch.confVersion`), `flush()` to make applied state durable. Plus `applied` ({index, term}), `confState`, `descriptor`, `lastVersion`, `appliedHlc`, `snapshot()` and `installSnapshot(meta, pairs)` of the range's span and range-local keys |
| `Split`, `Freeze`, `Merge` commands, `RangeHooks`, `findSplitKey`, `splitBoundary`, `localRanges` | Range lifecycle applied by the state machine itself (ADR-0009): split at a leader-chosen key boundary into a new range at index 5, freeze (a frozen range applies nothing but its unfreeze), merge a frozen right neighbour. Other packages move their range-local state through `RangeHooks`. `localRanges(store)` lists the ranges to reopen on start |
| `inSpan`, `spanIntervals`, `SpanReader`, `wholeKeyspace` | Range spans (ADR-0009): membership test, the intervals a range owns (minus `$node`), a reader clamped to a span |
| `RaftLogStore` | A range's Raft log in the log store: CRC-32C framed entries, hard state and truncated state. `load()`, `persist(update)` (one batch per Ready), `compact(point)` |
| `ensureStoreFormat`, `STORE_FORMAT` | Format marker check (format 3): stamps a new store, refuses an older one (ADR-0026, ADR-0027) |
| `ApplyHandler`, `ApplyContext`, `ApplyHandlerRegistry`, `BodyCase` | One handler per command body (`kvWrite`, `kvBatch`, `expire`, `gcThreshold`, …), registered by the composition root |
| `CommandStamper` | Request id (ULID) and HLC for a new command, decided before proposing |
| `IdempotencyTable`, `errorResult`, `rangeLocalKey` and node key helpers | Stored results per range and request id; deterministic error results; the raw `$node` key layout, where a range's own state is `$node/s/(r, rangeId, tag, …)` (ADR-0028) |

## Invariants

- **Deterministic apply.** Handlers get the log index, the version `max(cmd.hlc, lastVersion + 1)` (ADR-0027), the range descriptor, an MVCC transaction that sees only the range's span, `nowMs` from the command's HLC and `SeededRandom(index)`, and nothing else. Lint bans wall-clock and random globals in this package. Property test: two replicas applying the same log, and one installing a snapshot of it, hash identically.
- **One batch per apply.** Handler changes, the idempotency record and the applied point `{index, term}` are written together. Membership changes are written with their applied point too.
- **Idempotent.** A request id that was already applied returns its stored result and changes nothing.
- **Atomic snapshot install.** One synced batch deletes the range's old keys and state (other ranges in the store are untouched) and writes the snapshot. The snapshot's own applied point must match its metadata, or the install throws.
- **Fail-stop.** Out-of-order indexes, checksum mismatches, log gaps and storage errors throw. The replica stops for good and never skips an entry. Deterministic validation errors are recorded as results instead.
- **No compaction past durable state** (CLAUDE.md rule 7). The replica calls `flush()` before `RaftLogStore.compact`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_statemachine_apply_latency_seconds` | histogram | — |
| `mindlog_statemachine_applied_total` | counter | `body` |

Events: `CommandApplied` after every applied command.
