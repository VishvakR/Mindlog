---
description: Recall a scope as it was at a past moment, or only the facts that were true at a given time.
---

# Time travel

Because memories are never overwritten and every version is kept (MVCC, versioned by hybrid-logical-clock timestamps), Mindlog can answer two different questions about the past:

| Question | Option | Axis |
|---|---|---|
| "What did the agent **know** last Tuesday?" | `ASOF` | System time: the state of the database then |
| "What was **true** on 1 March?" | `VALID_AT` | World time: facts whose validity window contains that time |

They combine: "as the agent believed on 10 May, what was true on 1 March?"

## ASOF: the database as it was

```bash
MEM.SEARCH ana "where does Ana live?" ASOF 2026-05-10T09:00:00Z
MEM.SEARCH ana "where does Ana live?" ASOF 1842        # a log index of the scope's range
MEM.GET ana 01M7… ASOF 2026-05-10
MEM.EXPORT ana ASOF 2026-05-10                          # an archive of that state
```

REST and SDKs take `"asOf": {"time": "2026-05-10T09:00:00Z"}` or `"asOf": {"index": "1842"}`; MCP `recall` takes `as_of`.

`ASOF` is an MVCC snapshot read: memories forgotten since then reappear, later memories disappear, and the vector index is rebuilt from the vectors that existed at that version.

## VALID_AT: what was true

```bash
MEM.SEARCH ana "where does Ana live?" VALID_AT 2024-06-01
```

Only facts whose `[validFrom, validTo)` window contains the time are returned. By default recall uses `VALID_AT` = the `ASOF` time, or now. To make this useful, give facts validity when you know it:

```bash
MEM.ADD ana "Ana lives in Berlin" VALID_FROM 2024-03-01 VALID_TO 2025-08-31
MEM.ADD ana "Ana lives in Lisbon" VALID_FROM 2025-09-01
```

The two facts above contradict each other, but their windows do not overlap, so they are history, not a [conflict](conflicts.md).

## A memory's versions

```bash
MEM.HISTORY ana 01M7…
```

This lists every stored version of a memory, newest first, with its MVCC version, time and content: trust changes, evolution by consolidation, validity changes from conflict resolution, and forgetting. MCP: `history`. The dashboard **Time travel** page has a slider over the scope's history.

## Retention

History is kept until garbage collection: 30 days for memory by default (7 for KV). Open [branches](branches.md) pin their fork version. An `ASOF` older than the retained history returns what is left.
