# ADR-0030: Cross-range transactions with Percolator

- Status: accepted
- Date: 2026-10-17
- PLAN: 9.2 (cross-range transactions), 9.3 (snapshot consistency), 22 (simulator)
- References: [percolator.md](../references/percolator.md), [tikv.md](../references/tikv.md)

## Context

Writes that span ranges need atomicity. PLAN 9.2 picks Percolator over the PD TSO, behind `features.crossRangeTxn` (default off) until the simulator has tested it. KV writes are replicated as argv and re-executed in apply (ADR-0021). The gate is a bank-transfer invariant in the simulator.

## Decision

**API** (`@mindlog/txn` `TxnCoordinator`, domain layer, driven through the router):
```ts
run(tenant, fn: (txn) => Promise<Result<T>>): Promise<Result<T>>
txn.get(key) / txn.mget(keys)    // snapshot reads at startTs
txn.write(argv)                  // staged; keys from KvCommand.keys
```
`MULTI`/`EXEC` across ranges (and `MSET`, `RENAME`, `SMOVE` and the like when the flag is on) maps to one transaction holding the queued argv. `WATCH` keys become reads at `startTs`.

**Protocol** (snapshot isolation):
1. `startTs` comes from the PD TSO. Reads are snapshot reads at `startTs` on each range's leader, per ADR-0027.
2. The primary is the first written key.
3. **Prewrite**: one `TxnPrewrite {startTs, primary, ttlMs, writes[]}` command per range. For each key, apply:
   - fails with `CONFLICT` if the key's latest committed version is greater than `startTs`, or if a rollback record `(txn-rb, rangeId, key, startTs)` exists;
   - fails with `KEY_LOCKED{primary, startTs}` if another transaction holds a lock on it;
   - otherwise writes the lock `(lock, rangeId, key) → {startTs, primary, ttlMs, lockedAtMs, argv}`. A lock that already exists with the same `startTs` is idempotent.
   - The staged argv is the data. Nothing is written to MVCC yet.
4. `commitTs` comes from the TSO.
5. **Commit the primary**: `TxnCommit {startTs, commitTs, keys:[primary]}`. Apply checks the lock:
   - Present, and `startTs` matches: it runs the staged argv at version `max(commitTs, lastVersion + 1)` and deletes the lock. This is the commit point.
   - Absent: if a commit record `(txn-commit, rangeId, primary, startTs) → commitTs` exists, it succeeds idempotently; otherwise it fails with `ABORTED`.
   - It always writes the commit record for the primary.
6. **Commit the secondaries** in the background with the same command; a failure there does not fail the transaction.

**Lock resolution.** Readers and non-transactional writers that meet a lock get `KEY_LOCKED`. The router resolves the lock and then retries:
- It asks the primary's range with `TxnCheck {primary, startTs}`. In apply, that returns `committed(commitTs)` if the commit record exists, or `locked` if the lock is present and `lockedAtMs + ttlMs > nowMs`.
- Otherwise it rolls the primary back: it deletes the lock and writes the **protected rollback record**, so a late prewrite or commit fails (TiKV `check_txn_status_missing_lock`). It returns `rolledBack`.
- The router then rolls each secondary forward (`TxnCommit`) or back (`TxnRollback`).
- The `TxnCheck` time check uses `hlcPhysical(cmd.hlc)` of the `TxnCheck` command, so it is deterministic.

**Lock-resolver job.** On each range leader, the job scans `(lock, rangeId, …)` every `txn.resolveIntervalMs` (5 s) and resolves locks older than their TTL. The default TTL is 3 s.

**Cost when the flag is off.** Non-transactional applies skip the lock lookup unless the range holds at least one lock. The count of locks is kept in `range-stats`.

**Garbage collection.** Commit and rollback records follow the `GcThreshold` retention (ADR-0027).

## Alternatives considered

- **Locks as MVCC intents in the data keyspace** (CockroachDB): every reader of a key would have to understand intents. Keeping locks in `$node` range-local keys keeps the read path unchanged.
- **Writing data at `startTs` during prewrite** (classic Percolator): our writes are argv whose result depends on the current value, so executing at commit is the natural fit. It is still correct, because no other write lands on a locked key in between.
- **2PC with a coordinator log**: needs a coordinator record and recovery; Percolator's primary key is the record.

## Consequences

- With the flag on, a transaction takes 2 TSO round trips plus 2 Raft rounds on the primary's range.
- The simulator scenario `bank`:
  - accounts are spread over at least 4 ranges;
  - transfers run as transactions alongside splits, partitions, crashes and clock skew;
  - invariants: the total is conserved in every snapshot read, every committed transfer is visible exactly once, and after healing no lock remains and every account is ≥ 0.
- `features.crossRangeTxn` stays off by default until phase 9 uses it for unique indexes.
