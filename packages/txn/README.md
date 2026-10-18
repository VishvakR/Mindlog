# @mindlog/txn

Percolator transactions across ranges (ADR-0030), behind `features.crossRangeTxn`.

## Public API

- Apply handlers: `txnPrewriteHandler`, `txnCommitHandler`, `txnRollbackHandler`, `txnCheckHandler`; `lockGuard` (a `WriteGuard` for plain KV writes); `txnRangeHooks` (locks and records follow their keys on split and merge).
- `snapshotRead` — a read as of a timestamp that answers `LOCKED` instead of guessing, or `RANGE_MOVED` if the key left the range.
- `TxnCoordinator` / `Txn` — snapshot reads at a TSO timestamp, staged writes, prewrite on every range, commit of the primary (the commit point), then the rest. Declares the `TxnCluster` port it needs (timestamps, placement, one step on a range).
- `LockResolverJob`, `scanLocks` — clear the locks of transactions that stopped.

## Invariants

- A prewrite locks all its keys or none; a commit decides every key before it changes any.
- A commit writes at exactly `commitTs`; the keys are locked from prewrite on, so no version of them can exceed `startTs` until then.
- A rolled-back transaction leaves a rollback record, so a late prewrite or commit of it fails.
- Plain writes to a locked key are refused and not applied.
- All time comes from command HLCs; apply never reads a clock.

## Tests

Apply and hooks tests here; the bank-transfer invariant (every snapshot sums to the same total, no lock survives healing) is `SIM_BANK=1 scripts/sim.sh` in `test/sim`.

## Metrics

None yet; steps are ordinary replicated commands and show in the Raft and apply metrics.
