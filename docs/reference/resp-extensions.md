---
description: Full syntax of Mindlog's own RESP commands; MEM.*, CACHE.* and CLUSTER.*.
---

# Memory, cache and cluster commands

These commands extend the Redis protocol. `<scope>` is `user`, `user/agent` or `user/agent/session` within the connection's tenant (set by `AUTH mlk_…`, otherwise `default`). Times are ISO 8601 dates or date-times. Option names are case-insensitive. Replies are RESP3 maps (flattened to arrays in RESP2).

## Writing memory

| Command | Description |
|---|---|
| `MEM.ADD <scope> <text> [KIND <kind>] [SOURCE <source>] [VALID_FROM <t>] [VALID_TO <t>] [BRANCH <name>] [ASYNC]` | Remember text. Facts are extracted unless `KIND` is given. Replies `ids`, `degraded`, and `job` when enrichment is queued. [Guide](../guides/memory/remember.md) |
| `MEM.FORGET <scope> [BRANCH <name>] <id> [<id> …]` | Forget memories (append-only); replies with the count |
| `MEM.FORGET <scope> SOURCE <ref>` | Forget everything from a source and everything derived from it ([taint cascade](../guides/memory/trust.md)) |
| `MEM.TRACE <scope> <tool> <ok\|failed> [ARGS <json>] [RESULT <text>]` | Remember a tool call as a `tool_trace` ([guide](../guides/memory/portability.md#tool-traces)) |
| `MEM.TRUST <scope> <verified\|normal\|quarantined> [BRANCH <name>] <id> [<id> …]` | Set trust |
| `MEM.PIN <scope> <id> …`, `MEM.UNPIN <scope> <id> …` | Keep memories hot, or release them ([guide](../guides/memory/lifecycle.md)) |

`KIND`: `episodic`, `semantic`, `procedural`, `working`, `theme`, `tool_trace`. `SOURCE`: `user`, `agent`, `tool`, `web`, `document`, `system`, `consolidation`.

## Reading memory

| Command | Description |
|---|---|
| `MEM.SEARCH <scope> <query> [K <n>] [BUDGET <tokens>] [INHERIT] [INCLUDE_COLD] [RECIPE <r>] [ASOF <index\|time>] [VALID_AT <t>] [BRANCH <name>]` | Ranked memories: `id`, `text`, `kind`, `tier`, `score` per hit. [Guide](../guides/memory/recall.md) |
| `MEM.PACK <scope> <query> [BUDGET <tokens>] [INHERIT] [INCLUDE_COLD] [RECIPE <r>] [ASOF …] [VALID_AT …] [BRANCH …]` | Packed context: `context`, `tokens`, `budget`, `ids`, `dropped`, `compressed`, `degraded` |
| `MEM.GET <scope> <id> [ASOF <index\|time>] [BRANCH <name>]` | One memory, or nil |
| `MEM.HISTORY <scope> <id>` | Every stored version, newest first |

`RECIPE`: `rag`, `vector`, `hybrid`, `hybrid_ppr`, `full` (default).

## Conflicts

| Command | Description |
|---|---|
| `MEM.CONFLICTS <scope> [ALL] [LIMIT <n>] [AFTER <id>]` | Open conflicts, or all with `ALL` |
| `MEM.RESOLVE <scope> <id> KEEP <a\|b\|both> [VALID_FROM <t>]` | Resolve; the loser's validity ends. [Guide](../guides/memory/conflicts.md) |

## Branches

| Command | Description |
|---|---|
| `MEM.BRANCH <scope> <name>` | Create a branch that reads main as of now |
| `MEM.BRANCHES <scope>` | List branches: name, status, fork index and time, creator, writes |
| `MEM.DIFF <scope> <name>` | Added, forgotten and changed memories relative to main at the fork |
| `MEM.MERGE <scope> <name> [POLICY <abort\|raise\|prefer_branch\|prefer_main>]` | Merge (default `raise`); replies `merged`, `added`, `rejected`, `conflicts` |
| `MEM.DROP <scope> <name>` | Drop a branch and its writes |

[Guide](../guides/memory/branches.md)

## Change stream

| Command | Description |
|---|---|
| `MEM.WATCH <scope> [FROM <cursor>]` | Follow changes as RESP3 push messages, optionally from a cursor `rangeId:index`. [Guide](../guides/memory/change-streams.md) |

## Lifecycle and portability

| Command | Description |
|---|---|
| `MEM.CONSOLIDATE <scope> [<worker> …]` | Run consolidation now: `sleep`, `evolve`, `dedup`, `themes`, `entities`, `forget`, `reembed`, `cache` (and `split` when semantic split is on) |
| `MEM.JOBS <scope> [STATE <queued\|leased\|dead>] [LIMIT <n>] [AFTER <id>]` | Background jobs, with the scope's hot and cold counts |
| `MEM.EXPORT <scope> [ASOF <index\|time>]` | A `.mcube` archive (binary bulk string) |
| `MEM.IMPORT <scope> <archive> [FORMAT <mcube\|cogx>] [NAME <name>]` | Import an archive; memories follow the trust policy |

## Semantic cache

| Command | Description |
|---|---|
| `CACHE.SET <scope> <prompt> <answer> [USING <id> …] [TTL <seconds>]` | Cache an answer with the memories it depends on |
| `CACHE.GET <scope> <prompt> [THRESHOLD <0..1>]` | The cached answer for a similar prompt, or nil (default threshold 0.92) |
| `CACHE.DEL <scope> <id> …` | Drop entries; replies how many existed |

[Guide](../guides/semantic-cache.md)

## Cluster administration

| Command | Description |
|---|---|
| `CLUSTER.INFO` | This node's Raft role, term, leader, commit and applied indexes, and the range membership |
| `CLUSTER.ADDLEARNER <node-id> <address>` | Add a node as a non-voting learner |
| `CLUSTER.PROMOTE <node-id>` | Promote a caught-up learner to voter |
| `CLUSTER.REMOVE <node-id>` | Remove a voter or learner |
| `CLUSTER.TRANSFER <node-id>` | Hand leadership to a caught-up voter |

Membership commands are for clusters with static membership; with a placement driver, use the [cluster actions](../getting-started/deployment.md#operator-actions). One server is changed at a time (ADR-0006).
