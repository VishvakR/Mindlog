# ADR-0022: Collection generations for O(1) delete

- Status: accepted
- Date: 2026-10-12
- PLAN: 5.2 (Redis value encoding), 10.2 (MVCC, GC)
- References: [valkey.md](../references/valkey.md) (lazyfree `UNLINK`), [cockroach-encoding.md](../references/cockroach-encoding.md)

## Context

Hashes, lists, sets and sorted sets store one key per element (PLAN 5.2). Deleting, overwriting or expiring a key holding a million elements would otherwise need a million tombstones in one command, which blows the command size limit and makes `DEL` latency proportional to the collection size. Valkey avoids blocking with lazyfree (`UNLINK`); a replicated store needs the same thing as data, not as a background thread.

## Decision

- Every Redis key has a **header** at `k/(key)` with type, generation, element count, expiry, last-modified version and, for lists, head and tail sequence numbers (`KvHeader` in `proto/mindlog/v1/kv.proto`).
- Elements are stored **under the header's generation**: `k/(key, gen, tag, …)`. Tags are `'h'` field, `'l'` seq, `'s'` member, `'z'` member → score and `'Z'` score, member. Strings keep their value in the header.
- `DEL`, `UNLINK`, overwrite by another type, `RENAME` away and expiry all **bump the generation** (or tombstone the header). That is one write regardless of size. Old elements become unreachable immediately, because readers only look at the header's current generation.
- A dead generation is recorded in `s/deadgen/(tenant, key, gen)`. The leader's GC job proposes `GcThreshold` commands that delete dead generations' elements and old MVCC versions in **bounded batches**.

## Alternatives considered

- **Tombstone every element** (PLAN 5.2 as first written): no GC machinery, but O(n) commands and unbounded command size.
- **Rename-on-delete into a trash prefix**: still O(n) key moves.

## Consequences

- Reads of a collection first read its header (one point lookup), then scan `k/(key, gen, tag)`. That prefix is contiguous, so scans stay range-local and ordered.
- Space from deleted collections is reclaimed asynchronously. Backlog is visible as `mindlog_kv_dead_generations_count`.
- PLAN 5.2 is updated to show `gen` in element keys.
