# Mindlog

Mindlog is a Redis-compatible, Raft-replicated database that also serves as long-term memory for AI agents over MCP, and optionally as a PocketBase-style app backend. It runs fully offline: the server is TypeScript on Node.js, and local models run in a Python sidecar.

> **Status: phase 0, Foundations.** The repository has its tooling, the shared `core` library, the event bus and the protobuf contracts. The database, replication and memory engine are built phase by phase as described in [`docs/PLAN.md`](docs/PLAN.md) §24.

## Design in one paragraph

The full system design, with diagrams, is in [`docs/design.md`](docs/design.md).

Every state change is a command in a Raft log. Key-value data, memory records, indexes and caches are deterministic projections of committed commands (ADR-0003). The code is split into one package per module, in layers: interfaces → application → domain → replication → storage → core. Imports only point downward, and lint and tests enforce that (ADR-0002). Anything non-deterministic (time, randomness, model inference) enters through ports and is decided before a command is proposed.

## Repository layout

```
packages/
  core/        Result, error table, Clock/Random ports, ULID, HLC, key encoding, config, logging, metrics, tracing
  eventbus/    typed in-process domain events
  proto/       generated TypeScript for proto/
proto/         protobuf schemas (buf), package mindlog.v1
python/        uv workspace: model_service (sidecar skeleton), mindlog_proto (generated)
test/          cross-package tests (architecture gate) and lint fixtures
docs/          PLAN.md (what and when) and adr/ (why)
scripts/       clone-references.sh, gen-proto.sh
```

## Prerequisites

- Node.js 24 or newer (`.nvmrc`) and pnpm 10 (`corepack enable` picks the pinned version)
- [uv](https://docs.astral.sh/uv/) for everything Python (`uv python install 3.12`)

## Commands

```bash
pnpm install                 # install the workspace
pnpm build                   # compile packages to dist/
pnpm typecheck               # type-check sources and tests
pnpm lint                    # ESLint + layer boundaries, madge cycles, Prettier
pnpm test                    # unit, property and architecture tests
pnpm test:coverage           # tests with coverage thresholds
pnpm proto:gen               # regenerate TypeScript and Python from proto/
pnpm proto:breaking          # buf breaking-change check against main

# one package, one file, or one test name
pnpm --filter @mindlog/core test
pnpm vitest run packages/core/test/hlc.test.ts
pnpm vitest run -t "key encoding order"

cd python && uv sync && uv run pytest && uv run ruff check && uv run mypy model_service
```

## Documentation

- [`docs/design.md`](docs/design.md) is the system design: topology, components, request flows, replication, storage, the memory engine, failure handling and scaling, with diagrams.
- [`docs/PLAN.md`](docs/PLAN.md) holds scope, specifications, phases and exit gates.
- [`docs/adr/`](docs/adr) holds the architecture decision records (ADR-0001 to ADR-0004 so far).
- Each package has a README with its purpose, public API, invariants and the metrics it emits.

## Contributing

Every change is a small Conventional Commit (`feat(core): …`, checked by commitlint) with tests. Pull requests follow [the template](.github/pull_request_template.md), and CI runs lint, typecheck, tests and protobuf checks.
