# ADR-0023: The dashboard is a React + shadcn/ui static app

- Status: accepted
- Date: 2026-10-12
- PLAN: 17.1 (technology), 24 phase 2, 4.2 (`web` package)
- References: [pocketbase.md](../references/pocketbase.md) (embedded admin UI served at `/_/`)

## Context

PLAN 17.1 proposed SvelteKit with a static adapter. The dashboard must look modern and polished,
be built from a rich component library, work offline (no CDN), and talk only to the public HTTP
API. At the start of phase 2 the user chose React with shadcn/ui.

## Decision

- `web/` is a Vite + React + TypeScript single-page app styled with Tailwind CSS v4 and
  shadcn/ui components (copied into `web/src/components/ui`, owned by us).
- Routing with `react-router`, server state with `@tanstack/react-query`, long lists with
  `@tanstack/react-virtual`, icons from `lucide-react`.
- Vite builds static assets with `base: '/_/'` into `packages/server/dashboard/` (not committed);
  `adapter-http` serves them at `/_/` with an `index.html` fallback for client routes.
- The app uses only `/api/*` with a bearer token, the same API and authorization as any client.

## Alternatives considered

- **SvelteKit + shadcn-svelte** (PLAN 17.1): smaller bundles, but the user preferred React's
  larger ecosystem (graph, grid and editor components needed in later phases).
- **Server-rendered pages**: no build step, but no rich component library and a second rendering
  path to secure.

## Consequences

- `web` is a pnpm workspace package outside the `packages/*` layer rules; its own lint,
  typecheck, test and build run in CI.
- Later pages (graph, recall playground, time travel) pick React libraries: Cytoscape.js via
  `react-cytoscapejs` or similar, CodeMirror 6 via `@uiw/react-codemirror`.
- Revisit if bundle size hurts the offline single-binary build (phase 11).
