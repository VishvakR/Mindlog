# Phase 2 — HTTP API, dashboard v1, observability baseline: exit-gate evidence

- Date: 2026-10-12
- PLAN: §24 Phase 2
- Status: **gate met**, awaiting sign-off
- Decisions: ADR-0023 (React + shadcn/ui dashboard), ADR-0024 (Fastify adapter, superusers in `$system`, bearer tokens)

## Exit gate

| Criterion (PLAN 24) | Evidence | Result |
|---|---|---|
| Dashboard edit → visible in `redis-cli`, and vice versa | `test/compat/dashboard-roundtrip.test.ts`: a superuser created with the CLI logs in; a hash written over the REST API is read by ioredis (value and TTL); a sorted set written by ioredis is read and scanned over HTTP; an HTTP delete removes the key. Manual run in headless Chrome against a built node: a hash field edited in the data browser, a list created with New key and a 120 s expiry, then `redis-cli HGET user:1 name` → `Ada Lovelace`, `LRANGE ui:list 0 -1` → `first second`, `TTL ui:list` → `119`. Keys written by `redis-cli` (hash, zset, list, set, JSON, TTL strings) show with their types and TTLs | ✔ |
| Prometheus scrapes metrics | `GET /metrics` serves the text format from the node's registry: `mindlog_kv_*`, `mindlog_resp_*`, `mindlog_http_*`, `mindlog_statemachine_*`, process and event-loop series (`adapter-http` tests, `core` metrics test). `deploy/prometheus/prometheus.yml` scrapes `mindlog:8090/metrics`; Grafana provisions the "Mindlog node" dashboard from `deploy/grafana/` | ✔ endpoint and config; the compose stack was not run (see below) |
| A trace shows RESP → apply → storage | `test/integration/trace.test.ts`: with an OpenTelemetry SDK registered, a RESP `SET` from ioredis yields one trace `resp.command` → `kv.set` → `storage.write` (log append + fsync) and `statemachine.apply` with the right parents. In production `observability.tracing.endpoint` exports it over OTLP (compose points it at Jaeger) | ✔ |

## Phase 2 checklist (PLAN 24)

| Task | Where |
|---|---|
| `adapter-http`: Fastify, `/health`, `/ready`, `/metrics`, `/api/kv/*` (scan, get, set, delete, TTL), RFC 9457 errors, OpenAPI, admin auth (superuser bootstrap via CLI) | `packages/adapter-http` (50 tests: 401 matrix over every protected route, problem details for every error code, KV routes, OpenAPI, console, dashboard), `packages/services` (`KvBrowser`, `AdminService`), `mindlog-server superuser upsert`, `docs/api/http.md` |
| `web/` dashboard: login, Overview, Data browser (typed editors), Console (RESP over WebSocket proxy), Settings (read-only) | `web/` (React + shadcn/ui, ADR-0023); RESP codec and draft conversion unit tests; checked in light, dark and phone widths |
| Serve the dashboard at `/_/` from the server | `adapter-http` static serving with SPA fallback and CSP; `vite build` writes `packages/server/dashboard`, shipped in the server package |
| Metrics for RESP/HTTP; tracing spans; Grafana dashboard JSON | `mindlog_http_request_latency_seconds`, `mindlog_http_request_errors_total`, process metrics; spans `http.request`, `resp.command`, `storage.write`, `statemachine.apply`; `deploy/grafana/dashboards/mindlog.json` |
| Docker images and `docker-compose.yml` (`dev` profile) with the model service placeholder | `Dockerfile`, `python/model_service/Dockerfile`, `docker-compose.yml`, `python -m model_service` placeholder |

## Other checks run

| Check | Command | Result |
|---|---|---|
| Lint (ESLint + boundaries, madge, Prettier, oxlint for `web/`) | `pnpm lint` | ✔ |
| Typecheck (packages, tests, web) | `pnpm typecheck` | ✔ |
| Tests | `pnpm test` | ✔ 86 files, 726 tests + web 7 |
| Coverage | `pnpm test:coverage` | Statements 93.3%, branches 84.3%, functions 95.8%, lines 96.4% |
| Phase 1 gates still hold | `pnpm test:durability`; `pnpm fuzz:resp`; `scripts/bench-smoke.sh 100000 50`; `uv run pytest compat -m compat` | ✔ 50 kills (7,020 acknowledged writes of each kind, all present); 3 fuzz targets; benchmark numbers in line with phase 1 (SET 14.7k/s, GET 37.4k/s); redis-py 23/23 |
| Python | ruff, mypy --strict, pytest | ✔ 32 tests |
| Commits | `pnpm lint:commits` (whole history, after rewrapping 12 phase 0–1 messages) | ✔ |
| Dependencies | `pnpm audit` | ✔ only the previously accepted braces advisory |
| Images | Both images built; the server container started and passed into its healthcheck | ✔ (then removed at the user's request) |

## Defects found while building

| Found by | Defect | Fix |
|---|---|---|
| `AdminService` tests | KV apply refused every `$`-prefixed tenant, so the planned `$system` superuser store could not be written | `f8fab0d`: KV apply also accepts `$system`; `$node` stays refused (ADR-0024 updated) |
| Console WebSocket test | A refused WebSocket upgrade left the socket open, because our auth hook ran before `@fastify/websocket` marked the request | Register the plugin before our hooks |
| Vitest | The explicit `import` condition was passed to Node, so `require('ws')` got the ESM wrapper | `ef91003`: let Node add `import`/`require` itself |
| Durability test under parallel load | All random kills could land before the first acknowledged write | `2070669`: kill after the first acknowledged write |
| Browser check | A rebuilt dashboard 404'd until restart; the span wrapper turned static replies into empty 200s | `5626545`: per-request file lookup, SPA fallback in the not-found handler, no span wrapper on static routes |
| Browser check | Chrome's `scrollIntoView` returns a promise; returning it from an effect crashed the console page | Effects use statement bodies |

## Known gaps and follow-ups

- The `docker compose --profile dev` stack (Prometheus scraping, Grafana panels, Jaeger UI) was not run end to end; at the user's request Docker is only used to write the files. Run `docker compose --profile dev up --build` to see the scrape and the trace in the UIs.
- Login has no rate limiting and no TOTP/MFA (PLAN 17.3, phase 10).
- The console is a plain input with history, not CodeMirror; no command autocomplete yet.
- `/metrics` is unauthenticated, like most exporters; put it behind the network boundary in production.
- Large collections (more than 1,000 elements by default) are read-only in the dashboard; edit them in the console.
- No single-binary (SEA) build yet: the server serves `packages/server/dashboard` (phase 11). The dashboard bundle is 742 kB (237 kB gzip).
- Pipelined writes on one connection still do not share an fsync (phase 1 follow-up, phase 11).
