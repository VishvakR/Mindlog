# API reference

Reference material for Mindlog's external interfaces (PLAN 15):

| Document | Contents | Phase |
|---|---|---|
| `resp-compatibility.md` | Supported Redis commands and known differences | 1 |
| `openapi.json` | REST API, generated from the Zod schemas | 2 |
| `mcp-tools.md` | MCP tools, inputs, outputs and errors | 5 |

Error replies on every interface come from the single table in `@mindlog/core` (`ERROR_CODES`).
