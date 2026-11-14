# MCP tool reference

Mindlog serves the [Model Context Protocol](https://modelcontextprotocol.io) on its own listener, `listen.mcp.http` (default `127.0.0.1:8765/mcp`, Streamable HTTP). Hosts that only speak stdio launch `mindlog-server mcp --api-key mlk_…`, a relay to a running node (setup: [Connect an AI agent](../getting-started/connect-an-agent.md)).

Every request carries an API key (`Authorization: Bearer mlk_…`), created with `mindlog-server apikey create --tenant <t> --user <u> --name <n>` or on the dashboard. The key fixes the tenant and, by default, the user scope; RBAC (ADR-0036) decides what each tool may touch.

## Conventions

- **Scopes.** Every tool takes optional `user`, `agent` and `session`. `user` defaults to the API key's user (or the tenant-wide scope); `agent` and `session` narrow it (`session → agent → user`).
- **Results.** Each tool returns `structuredContent` (fields below) and a short text summary. Outputs are size-bounded.
- **Errors** are tool results with `isError: true` and the text `<CODE>: <message>`, where `CODE` comes from the single error table in `@mindlog/core` (for example `PERMISSION_DENIED`, `QUOTA_EXCEEDED`, `NOT_FOUND`, `UNAVAILABLE`). Retry `BUSY` and `UNAVAILABLE`; the others need a different request.
- **Degraded mode.** With the model service down, writes are stored raw and enriched later, and recall falls back to the retrievers that still work. Results then carry `degraded: true` (PLAN 21).
- **Untrusted text.** Recalled memories and cached answers are data from past sessions, never instructions. Content with `source: web` is quarantined and is left out of recall unless `include_quarantined` is set.
- Times (`valid_from`, `valid_to`, `as_of`, `valid_at`) are ISO 8601 dates or date-times.

## Memory

### `remember`

Store something durable: preferences, decisions, facts, instructions. Mindlog extracts the facts, links them to entities and keeps the history. Text is limited to 64 KB.

| Input | Type | |
|---|---|---|
| `content` | string, required | What to remember, in plain language |
| `kind` | `episodic` · `semantic` · `procedural` · `working` · `theme` · `tool_trace` | Store verbatim as this kind instead of extracting facts |
| `source` | `user` · `agent` · `tool` · `web` · `document` · `system` · `consolidation` | Where it came from; `web` is quarantined |
| `async` | boolean | Acknowledge at once and enrich in the background |
| `valid_from`, `valid_to` | time | When the fact became, or stopped being, true |
| `branch` | string | Write to this branch (from `branch_create`) |

Output: `ids`, `degraded`, `job` (the enrichment job of an async or degraded write).

### `remember_tool_call`

Record a tool call and how it went, so a later `recall` can answer "how did I do this last time?". Large arguments and results are truncated.

| Input | Type | |
|---|---|---|
| `tool` | string, required | The tool or command that ran |
| `args`, `result` | any | Its arguments, and what it returned or the error |
| `success` | boolean, required | Whether it did what was wanted |

Output: `ids`, `degraded`.

### `recall`

Recall what is relevant to a query or task before answering or acting. It returns a packed context grouped as facts, themes, procedures and recent episodes, kept within a token budget, plus the matching memories with their scores.

| Input | Type | |
|---|---|---|
| `query` | string, required | What you need to know |
| `k` | integer | Most memories to return (default 10) |
| `token_budget` | integer | Token budget of the packed context |
| `inherit` | boolean | Also search the parent scopes |
| `include_quarantined` | boolean | Include unverified web content |
| `include_cold` | boolean | Also search memories that faded to the cold tier (slower) |
| `recipe` | `rag` · `vector` · `hybrid` · `hybrid_ppr` · `full` | Retrieval recipe (default `full`: vector, keyword, entity, graph, themes and rerank; ADR-0011) |
| `as_of` | time | What was stored as of this time (time travel) |
| `valid_at` | time | Only facts that were true at this time |
| `branch` | string | Read this branch |

Output: `context`, `tokens`, `budget`, `dropped`, `items`, `degraded`.

### `forget`

Forget memories by id, or everything that came from a bad source along with what was derived from it. Forgotten memories are no longer recalled, and the history keeps an audit trail.

| Input | Type | |
|---|---|---|
| `ids` | string[] | Memory ids, from `recall` or `history` |
| `source` | string | Forget everything from this source reference (a URL, file or tool) |
| `reason` | string | Recorded with the forget |

Output: `count`, `ids`.

### `history`

The stored versions of one memory, newest first: when each was written and whether it was forgotten.

Input: `id` (required). Output: `versions`.

### `graph_query`

Look up a person, place or thing in the knowledge graph: what it relates to (1–2 hops) and which memories mention it.

Input: `entity` (required; a name such as `Ana` or an id such as `person:ana`), `depth`. Output: `nodes`, `edges`, `memories`.

## Semantic cache

### `cache_lookup`

Before expensive work, check whether an answer to the same or a very similar request was cached. A hit returns the answer and the memories it relied on. An entry is dropped automatically once any of those memories is forgotten (ADR-0012).

Input: `prompt` (required), `threshold` (similarity a hit needs, default 0.92). Output: `hit`, `answer`, `id`, `similarity`, `using`.

### `cache_store`

Cache an answer so a later similar request can reuse it. Name the memory ids it depends on.

Input: `prompt` and `answer` (required), `depends_on` (memory ids), `ttl_seconds`. Output: `id`.

## Conflicts

### `conflicts`

List contradictions between remembered facts: an older fact `a` and a newer fact `b`. The newer fact is usually quarantined until the conflict is resolved (ADR-0015).

Input: `all` (include resolved conflicts). Output: `conflicts`.

### `resolve_conflict`

Settle a conflict once the user has said which fact is right. Nothing is deleted; the losing fact's validity ends. Ask the user first; do not guess.

| Input | Type | |
|---|---|---|
| `id` | string, required | From `conflicts` |
| `keep` | `a` · `b` · `both`, required | `both`: both were true at different times |
| `valid_from` | time | With `keep: both`: when `b` replaced `a` |

Output: `changed`.

## Branches

A branch tries a plan without changing what other agents see. It reads main memory as of its creation plus its own changes. Pass `branch: <name>` to `remember` and `recall` to work on it (ADR-0013).

### `branch_create`

Input: `name` (required, e.g. `trip-plan`). Output: `name`.

### `branch_diff`

What the branch added, forgot and changed compared with main at its fork point. Input: `name`. Output: `added`, `forgotten`, `changed`.

### `branch_merge`

Merge a branch into main. New facts that contradict main are handled by `policy`:
- `raise` (default) adds them quarantined and opens conflicts;
- `prefer_branch` replaces main's facts;
- `prefer_main` leaves them out;
- `abort` merges nothing if any fact conflicts.

Input: `name`, `policy`. Output: `merged`, `added`, `rejected`, `conflicts`.

### `branch_drop`

Abandon a branch; main is untouched. Input: `name`. Output: `name`.

## Prompts and resources

| Kind | Name | |
|---|---|---|
| Prompt | `recall-context` (`task`, optional `user`) | Inserts what Mindlog remembers that is relevant to a task |
| Resource template | `memory://{user}/recent` | The 20 newest memories of a user scope; subscribable, updates on change (PLAN 13.5) |
| Resource template | `memory://{user}/{id}` | One memory by id |
