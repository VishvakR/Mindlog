# ADR-0029: Request routing, forwarding and range epochs

- Status: accepted
- Date: 2026-10-17
- PLAN: 8.4 (routing), 8.1 (epochs), 9.1 (single-range transactions), 15 (RESP)
- References: cockroach-multiraft.md, tikv-pd.md

## Context

Clients connect to any node over RESP or HTTP and expect a single Redis. With many ranges, the node they reach may not hold the range for a key, or may hold only a follower of it. Multi-key commands may span ranges. The user chose to reject writes that span ranges while `features.crossRangeTxn` is off, except for commands that can be fanned out.

## Decision

**Router** (`@mindlog/router`, application layer) sits between `KvService` and the replication layer:
1. Encode each key of the command, using `KvCommand.keys` positions, to its header key `tenant · 'k' · (name)`. Look up the range in the **range cache**: a sorted map of descriptors, filled from PD `GetRange`/`ScanRanges` and updated by local `RangeSplit`/`LeaderChanged` events.
2. If this node holds an initialised replica of that range, run the command locally: propose on that replica, and for reads apply its read barrier and read local state. A follower forwards the proposal to its leader through Raft (phase 3 behaviour), and runs lease and linearizable reads through ReadIndex.
3. Otherwise, send `Kv.Execute {tenant, principal, argv | batch, rangeId, epoch, hlc, deadline}` over the internal Connect listener to the node of the cached leader, or to any replica if the leader is unknown. The receiving node runs step 2 and never forwards a second time; instead it returns `NOT_LEADER{leaderNodeId}` or `RANGE_MOVED{descriptor}`.
4. Retries:
   - On `NOT_LEADER` with a hint, the router updates the cache and retries at once.
   - On `RANGE_MOVED`, the router installs the returned descriptor, or refreshes from PD if none is returned, and retries.
   - On `UNAVAILABLE` or `BUSY`, it backs off exponentially (10 ms × 2ⁿ, capped at 1 s) with full jitter.
   - It gives up at the request deadline (`DEADLINE_EXCEEDED`).
   - Writes keep the same request id across retries, so apply deduplicates them.

**Epochs.**
- A request carries the `{rangeId, epoch}` it targeted. The receiving replica checks both at propose time, and again in apply.
- Apply checks that every key is in the span and that the range is not frozen. A request with a stale `epoch.version` whose keys still fall in the span is accepted. A request whose key is outside the span, or for a frozen or destroyed range, fails with `RANGE_MOVED`. Its `fields.descriptor` holds the current descriptor, base64-encoded proto, when one is known.
- The apply-time check is deterministic: it uses only the applied descriptor.

**Multi-key commands:**
- Commands whose keys all fall in one range are proposed as one command, as before (PLAN 9.1). This includes `MULTI`/`EXEC` with `WATCH`.
- **Fan-out:**
  - `MGET`, `EXISTS`, `TOUCH`, `DEL` and `UNLINK` are split by range and run in parallel, each part under the same deadline.
  - Results are merged in input order: arrays for `MGET`, sums for the counting commands.
  - Each part has its own request id, derived from the parent id and the part number.
  - A failed part fails the whole command after the other parts finish.
  - Parts that were applied stay applied. These commands are not atomic across slots in Redis Cluster either.
- Every other command with keys in more than one range, and `MULTI`/`EXEC` across ranges, fails with **`CROSS_RANGE`** (RESP `-CROSSSLOT Keys in request don't hash to the same slot`, HTTP 400, gRPC FAILED_PRECONDITION). With `features.crossRangeTxn` on, they run as Percolator transactions instead (ADR-0030).
- `SCAN`, `KEYS`, `DBSIZE`, `RANDOMKEY` and `FLUSHDB` visit the tenant's ranges in key order.
  - The SCAN cursor is the encoded last key, which is already opaque (phase 1), so it survives splits.
  - `KEYS` and `DBSIZE` keep their phase 1 bounded limits.

**Jobs.** The expiry and GC jobs iterate the ranges whose leader is local and propose per range.

## Alternatives considered

- **Client-side routing with `-MOVED`** (Redis Cluster): clients would need cluster-aware drivers, and `redis-cli` without `-c` would break.
- **Forwarding at the Raft layer only**: works for proposals, but a node that holds no replica of the range has no Raft group to forward through.
- **Non-atomic fan-out for all multi-key writes**: surprises users who expect `MSET` to be atomic.

## Consequences

- One extra network hop when the client's node does not hold the leader. `CLUSTER.INFO` reports the leader so clients can connect there.
- Cross-range errors show up in the compat tests. The default single-node setup has one range for small data, so existing users see no change until a split happens.
- New error code `CROSS_RANGE` in the one error table.
