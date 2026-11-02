# @mindlog/adapter-http

HTTP adapter (layer `interfaces`, PLAN 15.3 and 17, ADR-0024). Fastify serves:

| Path | Auth | What |
|---|---|---|
| `GET /health` | — | Liveness, always `{status: "ok"}` |
| `GET /ready` | — | 200 once recovered and listening, else 503 |
| `GET /metrics` | — | Prometheus text exposition |
| `POST /api/superusers/auth-with-password` | — | `{email, password}` → `{token, superuser}` |
| `GET /api/superusers/exists` | — | Whether a superuser exists (login page hint) |
| `GET /api/superusers/me` | bearer | The authenticated superuser |
| `GET /api/kv/keys` | bearer | SCAN page: `cursor`, `match`, `type`, `count` |
| `GET/PUT/DELETE /api/kv/keys/:key` | bearer | Typed read, atomic replace (value + TTL), delete |
| `PUT /api/kv/keys/:key/ttl` | bearer | `{ttlMs}`; `null` persists |
| `GET /api/admin/overview`, `/api/admin/settings` | bearer | Node status; config with secrets redacted |
| `POST /api/memory/{remember,recall,pack,get,list,forget,history,graph,scopes,conflicts,resolve,trust,branch,branches,diff,merge,drop,pin,consolidate,jobs,export,import}` | bearer | Memory operations (PLAN 15.3); archives travel base64, and `import` takes bodies up to 48 MB with an explicit `tenant`; the superuser is the principal |
| `GET /api/realtime?tenant=&user=&from=` | bearer | A user scope's memory changes as Server-Sent Events; each event's id is its cursor, so `Last-Event-ID` resumes; an old cursor gets `resync` (PLAN 13.5) |
| `GET /api/console` | bearer (subprotocol) | RESP over WebSocket, subprotocols `mindlog.resp` + `bearer.<token>` |
| `GET /api/openapi.json` | — | OpenAPI 3.1 built from the Zod schemas |
| `GET /_/*` | — | Dashboard static assets with SPA fallback and CSP |

## Public API

- `HttpServer` (`ready()`, `listen()`, `close()`, `app` for `inject` in tests) with `HttpServerDeps`.
- `toProblem`, `PROBLEM_CONTENT_TYPE`, `CONSOLE_PROTOCOL`.

## Invariants

- Adapter only: every request is validated with the services' Zod schemas and handed to
  `KvBrowser`, `AdminService` or a RESP `Connection`; no storage access.
- Every error is RFC 9457 `application/problem+json` from the core error table; `cause` is never
  serialised.
- Every `/api/*` route except login, `exists` and the OpenAPI document requires a valid
  superuser token. There are no cookies (no CSRF surface).
- Request bodies are bounded by `bodyLimit`; console frames by the RESP parser limits.

## Metrics and spans

- `mindlog_http_request_latency_seconds{method,route,status}`
- `mindlog_http_request_errors_total{route,status}`
- Span `http.request` around every handler (service spans nest under it).
