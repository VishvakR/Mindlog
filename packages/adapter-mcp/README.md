# @mindlog/adapter-mcp

Agents remember and recall over the Model Context Protocol (PLAN 15.2). The adapter is thin: it authenticates, authorizes and validates each call, then calls `MemoryService`. There is no business logic here.

## Public API

- **`McpHttpServer`**: MCP over Streamable HTTP on its own Fastify listener (`listen.mcp.http`, default `127.0.0.1:8765`, path `/mcp`), built with `@modelcontextprotocol/server` 2.x, `node` and `fastify`.
  - Stateless: a fresh `McpServer` is built per request for the caller's API key (`Authorization: Bearer mlk_…`, checked by `ApiKeyService.verify`).
  - `subscriptions/listen` streams (protocol 2026-07-28) get `notifications/resources/updated` for `memory://{user}/recent` when that scope changes. Handlers are kept per tenant and pinned user, so a stream only hears about scopes its key may read.
  - Requests without a valid key get `401`. A `Host` or `Origin` header outside localhost (or outside `allowedHosts`) gets `403`, which is the DNS-rebinding protection.
- **`buildMcpServer(memory, key, version)`**: the tools, resources and prompt for one caller.
  - Tools: `remember` (with validity dates and a `branch`), `remember_tool_call` (a tool call and its outcome, PLAN 13.11), `recall` (with `as_of`, `valid_at`, `include_cold` and a `branch`), `forget` (by ids, or everything from a `source`), `history`, `graph_query`, `cache_lookup`, `cache_store`, `conflicts`, `resolve_conflict`, `branch_create`, `branch_diff`, `branch_merge` and `branch_drop`. Each has a Zod input and output schema, returns structured content plus a short text, keeps outputs bounded (at most 20 items), and reports errors as `isError` results (`CODE: message`).
  - Resources: `memory://{user}/recent` (the 20 newest) and `memory://{user}/{id}`.
  - Prompt: `recall-context {task}` inserts the packed recall for a task, marked as data, not instructions.
- **`runStdioProxy({url, apiKey})`** and **`proxyMessages(local, remote)`**: `mindlog-server mcp` relays a host's stdio to the HTTP endpoint, so several local hosts share one running node and its data directory.

## Invariants

- Every call runs as its API key: the key's tenant, and the key's user when it is pinned to one (`authorizeScope`). The default scope is the key's user, or the tenant-wide scope. Keys never carry admin rights.
- Memory text in results and prompts is data from past sessions. Tool descriptions tell the model so.

## Metrics and spans

Calls reach `MemoryService`, so they produce the `memory.*` spans and metrics. The principal recorded on memories is `apikey:<id>`.
