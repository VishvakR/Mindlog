# Phase 0 — Foundations: exit-gate evidence

- Date: 2026-10-12
- PLAN: §24 Phase 0
- Status: **gate criteria met; awaiting sign-off before phase 1 starts**

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| `pnpm lint` passes | ESLint (typescript-eslint strict-type-checked + layer boundaries + determinism bans), madge cycles, Prettier | ✔ No problems, no circular dependencies |
| `pnpm test` passes | Vitest: 21 files, 180 tests (unit, property, contract, architecture) | ✔ 180 / 180 in ~3 s |
| Boundary rules block an intentional illegal import | `test/architecture/boundaries.test.ts` runs the ESLint CLI over `test/lint-fixtures/`: upward layer import, relative and deep cross-package imports, default export, `Date.now` / `Math.random` / `new Date()` in apply code are all reported; legal code is clean | ✔ 7 / 7 |
| Key-encoding order holds for 100k random tuples | `packages/core/test/keys/key-order.test.ts`: 100,000 prefix-sharing random pairs compared bytes vs a spec oracle, and 100,000 random tuples sorted both ways | ✔ ~2 s |

## Other checks run

| Check | Command | Result |
|---|---|---|
| Typecheck (sources + tests) | `pnpm typecheck` | ✔ |
| Build | `pnpm build` | ✔ |
| Coverage | `pnpm test:coverage` | Statements 96.5%, branches 88.9%, functions 95.8%, lines 97.1% (thresholds 85/80/85/85) |
| Python | `uv run ruff check`, `ruff format --check`, `mypy --strict`, `pytest` | ✔ 5 tests |
| Protobuf | `buf lint`; regenerate + `git diff --exit-code`; `buf breaking` proven to catch a renumbered field | ✔ |
| TS ↔ Python wire compatibility | Golden `Command` bytes asserted in both languages | ✔ |
| Commits | `pnpm lint:commits` over the full history | ✔ (one warning: a body line starting with `strict:` reads as a footer) |
| Dependencies | `pnpm audit`; `pip-audit` over the locked Python requirements | ✔ handlebars patched by override; braces GHSA-vfj7-8cjw-p6xm accepted (no fix exists; only our own lint globs reach it) |

## Phase 0 checklist (PLAN 24)

| Task | Where |
|---|---|
| pnpm workspace, TS project references, shared tsconfig, ESLint + boundaries, Prettier, Vitest, fast-check, madge | root configs, `tsconfig*.json`, `eslint.config.js`, `vitest.config.ts`, `.madgerc` |
| Python workspace with uv, ruff, mypy, pytest | `python/` |
| `proto/` with buf, codegen for TS and Python, `common.proto`, `commands.proto` (envelope only) | `proto/`, `buf*.yaml`, `scripts/gen-proto.sh`, `packages/proto`, `python/mindlog_proto` |
| `@mindlog/core` | Result, error table, ULID, HLC, tuple key encoder + property tests, Clock/Random ports with real and fake implementations, config loader with schema validation, pino logger, metrics registry, OpenTelemetry setup |
| `@mindlog/eventbus` with typed events | `packages/eventbus` |
| CI steps 1–4, PR template, Conventional Commits check, changesets | `.github/`, `.changeset/`, `commitlint.config.js` |
| `docs/` skeleton, ADR template, ADR-001 to ADR-004, design doc | `docs/adr/`, `docs/design.md` |
| References setup script | `scripts/clone-references.sh` |

## Decisions and deviations recorded during phase 0

- **Key encoding** (PLAN 5.1 updated): FoundationDB tuple typecodes with variable-length integers; `/` is notation only; the version suffix follows a `0x40` marker.
- **Random port** has no `seed()`; only `SeededRandom` can be reseeded (see `packages/core/README.md`).
- **TypeScript 6.0**, not 7.0: typescript-eslint supports `< 6.1`.
- **`@prometheus-io/client`** replaces the deprecated `prom-client` (same API).
- **madge** declares a TypeScript 5 peer; allowed for 6.0 after verifying cycle detection with an injected cycle.

## Follow-ups for phase 1

- Write `docs/references/` analyses for Valkey before the RESP command table (analyses stay local).
- Add `KvStore` port, contract suite and LevelDB adapter; add a "next key" helper for exclusive scan bounds (see the CockroachDB analysis).
