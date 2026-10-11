# ADR-0002: Hexagonal architecture, package per module, enforced boundaries

- Status: accepted
- Date: 2026-10-11
- PLAN: 2 (principles 2, 3, 10), 4.1–4.3 (layers, packages, ports), 23.1, 23.6
- References: [pocketbase.md](../references/pocketbase.md), [etcd-raft.md](../references/etcd-raft.md), [letta.md](../references/letta.md), [node-redis.md](../references/node-redis.md), ANALYSIS.md "Cross-cutting conclusions"

## Context

Mindlog spans protocols, consensus, storage, indexes, an AI memory engine and an app backend. Without hard boundaries, a solo project of this size drifts into god objects. The references show both outcomes:

- PocketBase's `App` interface exposes dozens of methods and ~86 hooks, and Mem0's `main.py` is a ~3,900-line class with duplicated sync/async paths. Both are hard to test in isolation.
- etcd raft keeps a pure core behind a narrow `Ready`/`Advance` contract, and its own `Storage` TODO regrets one wide interface.
- Letta Code turns maintainability rules into fixture-tested checks.

Deterministic simulation (PLAN 22.2) also requires that network, disk, clock and randomness are injectable everywhere.

## Decision

1. **Layers, imports pointing downward only**: interfaces → application → domain → replication → storage/index → core (CLAUDE.md §3.1).
2. **One pnpm workspace package per module** (`packages/<name>`), each with `src/`, `test/` and `README.md`, and `index.ts` as the only public entry. The package name is `@mindlog/<name>`.
3. **Ports are declared by the consumer**, are narrow, and have a production adapter, an in-memory fake, and a shared contract test suite.
4. **Concrete adapters are wired only in the composition root** `packages/server/src/bootstrap/`.
5. **Enforcement in CI**, never by convention alone:
   - `eslint-plugin-boundaries` maps each package to its layer and rejects upward imports.
   - `no-restricted-imports` rejects deep imports (`@mindlog/*/src/**`, relative paths that escape a package).
   - Restricted globals (`Date.now`, `Math.random`, `performance.now`, `new Date()`) are banned in `**/statemachine/**` and `**/apply/**`.
   - `madge --circular` rejects cycles.
   - A **fixture test** proves each rule actually fires (pattern from Letta Code's maintainability checks).

## Alternatives considered

- **A single package with folders and conventions**: cheaper at first, but nothing stops deep imports, and the build cannot tell which modules a change affects.
- **Nx/Turborepo project graph rules**: capable, but they add a heavy toolchain. ESLint boundaries plus TypeScript project references give the same guarantees with tools we already need.
- **Dependency-cruiser instead of eslint-plugin-boundaries**: comparable. We picked the ESLint plugin so violations appear in the editor with the rest of lint.

## Consequences

- Adding a package means adding a boundary-config entry, a `tsconfig` reference and a Vitest project. This is documented in the root README.
- Some code that could be shared stays duplicated across layers to avoid upward imports. That is an accepted cost: shared code goes down into `core`, or it is a port.
- Packages resolve each other's TypeScript source through a custom export condition (`@mindlog/source`) in tests and typechecking, so no build is needed before `pnpm test`. Published builds use `dist/`.
- Revisit if the per-package overhead noticeably slows the phase cadence. The fallback is merging packages within the same layer, never relaxing the layer rule.
