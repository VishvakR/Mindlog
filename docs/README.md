# Mindlog documentation

| Start here | |
|---|---|
| [Getting started](getting-started.md) | One node; Redis, MCP memory, models, dashboard |
| [System design](design.md) | Topology, request flows, replication, storage, the memory engine and failure handling, with diagrams |
| [SLOs, measured](slo.md) | Targets against what was measured, and what was not |

| Reference | |
|---|---|
| [RESP compatibility](api/resp-compatibility.md) | Supported Redis commands, `MEM.*`, `CACHE.*`, `CLUSTER.*`, and differences |
| [MCP tools](api/mcp-tools.md) | Tools, inputs, outputs, errors, prompts and resources |
| [HTTP API](api/http.md) and [OpenAPI](api/openapi.json) | REST endpoints; regenerate the JSON with `scripts/openapi.sh` after `pnpm build` |
| [TypeScript SDK](../packages/sdk-ts/README.md) and [Python SDK](../python/sdk/README.md) | Clients, embedded replicas, LangGraph and CrewAI adapters |
| Package READMEs (`packages/*/README.md`) | Each package's public API, invariants and metrics |

| Operating | |
|---|---|
| [Runbooks](runbooks/README.md) | Crash, disk full, failover problems, restore, upgrades, rotations, tenant deletion |
| [Configuration](PLAN.md#appendix-b--configuration-file-reference-mindlogyaml) | `mindlog.yaml` reference (PLAN Appendix B) |

| Why and how it was built | |
|---|---|
| [Architecture decisions](adr/README.md) | ADR-0001 to ADR-0041 |
| [Plan](PLAN.md) | Scope, specs and phases with exit gates (§24) |
| [Phase evidence](phases/) | What each phase gate measured |
| [Evals](evals/README.md) | LongMemEval, LoCoMo, conflicts, cache and forgetting results |
| [Design write-up](blog/design-writeup.md) and [demo script](demo/video-script.md) | The trade-offs, and a 5-minute walkthrough |
