# Mindlog

Mindlog is a Redis-compatible, Raft-replicated database that is also long-term memory for AI agents over MCP, and optionally a PocketBase-style app backend. It runs fully offline: the server is TypeScript on Node.js, and local models run in a Python sidecar.

- **Redis-compatible KV** over RESP2/3: strings, hashes, lists, sets, sorted sets, JSON, TTLs, `MULTI`/`EXEC`/`WATCH`.
- **Replicated**: Multi-Raft ranges with a placement driver, automatic splits and rebalancing, leader failover in under 2 s. It is checked by a deterministic simulator and Jepsen Maelstrom.
- **Agent memory**: fact extraction, embeddings, entities and a knowledge graph. Hybrid recall (vector, BM25, entity and graph walks, rerank) is packed to a token budget. Also: conflict detection at commit time, memory branches, time travel (`ASOF`), provenance and trust, consolidation and forgetting, and a semantic cache. All of it is available over MCP, RESP (`MEM.*`) and REST.
- **App backend**: collections with rules, app auth, files and realtime.
- **Operations**: tenants with RBAC, quotas and an audit log; TLS/mTLS; encryption at rest; full backups; a React dashboard.

## Quick start

```bash
pnpm install && pnpm build
pnpm dev                                   # RESP :6379, dashboard http://localhost:8090/_/, MCP :8765
redis-cli -p 6379 SET greeting hello
```

The full walkthrough, with models, MCP keys and the dashboard, is in [`docs/getting-started.md`](docs/getting-started.md).

## Design in one paragraph

Every state change is a command in a Raft log. Key-value data, memory records, indexes and caches are deterministic projections of committed commands (ADR-0003). Anything non-deterministic (time, randomness, model inference) enters through ports and is decided before a command is proposed (ADR-0016). The code has one package per module, in layers: interfaces → application → domain → replication → storage → core. Imports only point downward, and lint and tests enforce that (ADR-0002). Details and diagrams: [`docs/design.md`](docs/design.md).

## Repository layout

```
packages/     one package per module: core, storage, raft, multiraft, pd, statemachine, kv, memory,
              consolidation, branching, cache, collections, rules, auth, services, adapter-*, sdk-ts, server
proto/        protobuf schemas (buf), package mindlog.v1
python/       uv workspace: model_service (ONNX sidecar), sdk, evals, demo_agents, mindlog_proto
web/          dashboard (React + shadcn/ui)
test/         simulator, integration, Maelstrom, benchmarks, compatibility
docs/         design, plan, ADRs, API reference, runbooks, evals, phase evidence
deploy/       Prometheus, Grafana, compose profiles
```

## Commands

```bash
pnpm lint && pnpm typecheck && pnpm test     # what CI runs for TypeScript
SIM_SEEDS=1000 pnpm sim                      # deterministic simulator (or scripts/sim.sh <seeds> <shards>)
pnpm test:durability                         # kill -9 under load loses nothing acknowledged
cd python && uv sync && uv run pytest        # Python
docker compose --profile cluster up          # a 3-node cluster (`--profile dev`: 1 node + models + observability)
```

## Documentation

The index is [`docs/README.md`](docs/README.md). It covers the API reference (RESP, MCP, HTTP/OpenAPI), the SDKs, runbooks, measured SLOs, evals, and the 41 architecture decision records.

## Contributing and license

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`SECURITY.md`](SECURITY.md). Mindlog is released under the [MIT license](LICENSE).
