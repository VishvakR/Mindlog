# ADR-0027: MVCC versions are per-range HLC timestamps

- Status: accepted
- Date: 2026-10-17
- PLAN: 10.2 (MVCC), 9.2 (Percolator), 9.3 (snapshot reads), 13.3 (ASOF)
- References: [tikv.md](../references/tikv.md), [cockroach-multiraft.md](../references/cockroach-multiraft.md), [hlc.md](../references/hlc.md)
- Amends: PLAN 10.2 ("version = commit index"), ADR-0026 (store format 2 → 3)

## Context

Phase 1 made the MVCC version of a write the Raft log index of the command that wrote it. That works while there is a single log. With many ranges it breaks in three ways:
- A split gives the right range a new log that starts at index 5 while its data carries the parent's versions.
- A merge mixes two index spaces in one range.
- Percolator (PLAN 9.2) writes data at TSO timestamps, so transactional writes need versions that are comparable across ranges.

The user chose per-range HLC timestamps.

## Decision

**Version rule.** Each range keeps `lastVersion`, stored at `$node/s/(last-version, rangeId)` and written in every apply batch. A command's version is

```
version = max(cmd.hlc, lastVersion + 1)
```

computed in apply. It is deterministic, because `cmd.hlc` is in the log. Versions are uint64 values in `Hlc` layout (48-bit ms, 16-bit counter), so they compare directly with TSO timestamps. Every MVCC write of the command uses it, and `nowMs` for TTL stays `hlcPhysical(cmd.hlc)`.

**Leader stamping.** The proposer's HLC can be behind the leader's: a follower stamps a command and forwards it. So the range leader re-stamps every proposal it appends, including forwarded ones, with `cmd.hlc = max(cmd.hlc, leaderHlc.now(), termFloor)`.
- The re-stamp is done by a hook in `RawNode` that the host provides (`stampProposal(data) → data`). It runs only on the leader and only before the entry enters the log, so apply stays deterministic.
- `termFloor` is set to `leaderHlc.now() + 2 × maxClockOffsetMs` when the replica becomes leader. Snapshot reads that an old leader served at `ts ≤ oldWall + maxOffset` are therefore below any version the new leader assigns. This is the low-water mark of CockroachDB's timestamp cache.

**Snapshot reads at `ts`** (transactions, `ASOF`), served by the leader under lease:
1. `leaderHlc.update(ts)`, which rejects a `ts` more than the max offset ahead.
2. Note `lastIndex`.
3. Wait until `applied ≥ lastIndex`.
4. Read at version `ts`.

Entries already in the log may carry a version ≤ ts and are applied before the read. Entries appended later get a version > ts because of step 1. So a snapshot read at `ts` never changes afterwards (TiKV `max_ts`).

**What follows the new version:**
- `WATCH` versions;
- the `GcThreshold` field `below_version` (the GC job keeps `gc.retainMs`, default 10 min, of history; `below_index` is reserved);
- the idempotency age index, `idem-at/(rangeId, version, requestId)`;
- the dead-generation records;
- `appliedHlc` for bounded-staleness reads.

Change-stream cursors stay `(rangeId, index)` (ADR-0019), since they name log positions, not versions.

**Split and merge.** The right range inherits the left range's `lastVersion`. A merge takes the maximum of the two. Versions inside a span therefore keep growing, whichever log wrote them.

**Format.** `STORE_FORMAT = 3`. Phase 3 data directories are refused with the same message as in ADR-0026; there is no migration, because only development data exists.

## Alternatives considered

- **Log index plus an inherited base** (`version = base + index`): fewer changes, but transactions would need a second timestamp space, and `ASOF` would still need the index→time table.
- **TSO for every write** (TiKV): one PD round trip per write, and the data path would depend on PD.
- **Versions assigned by the proposer**: a follower's clock behind the leader's would break snapshot reads (TiKV's `max_ts` exists to prevent this).

## Consequences

- `ASOF <time>` reads at `packHlc(time, 0xffff)` directly. PLAN 10.2's `s/idxtime` table is not needed.
- Versions can run ahead of wall time by up to `2 × maxClockOffsetMs` after a leader change. This is harmless: TTL uses `hlcPhysical(cmd.hlc)`, and the HLC catches up.
- Tests: version monotonicity across split and merge (unit); repeatable snapshot reads while writes are forwarded from lagging-clock followers (simulator); the bank-transfer invariant (ADR-0030).
