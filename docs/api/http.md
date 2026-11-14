---
description: The REST API; authentication, every endpoint group, value formats and errors.
---

# HTTP API

Served on `listen.http` (default `0.0.0.0:8090`). The live **OpenAPI 3.1** document is `GET /api/openapi.json`, built from the same Zod schemas that validate requests. A copy is kept in the repository as [`openapi.json`](openapi.json) (regenerate it with `scripts/openapi.sh` after `pnpm build`).

## Authentication

| Credential | How to get it | Send it as |
|---|---|---|
| Superuser token | `POST /api/superusers/auth-with-password` with `{email, password}` → `{token, superuser}`. Lasts one day; resetting the password revokes it | `Authorization: Bearer <token>` |
| Tenant member token | Same endpoint, for accounts limited to one tenant | `Authorization: Bearer <token>` |
| API key | `mindlog-server apikey create`, the tenant API, or the dashboard | `Authorization: Bearer mlk_…` |
| App-user token | `POST /api/collections/:c/auth-with-password` and other [sign-in methods](../guides/app-backend/authentication.md) | `Authorization: Bearer <token>` |
| Delegated token | `POST /api/auth/delegate` | `Authorization: Bearer <token>` |

The tenant comes from the credential, else from the `X-Mindlog-Tenant` header, else `collections.defaultTenant`. The WebSocket console cannot set headers, so it sends the token as a subprotocol: `new WebSocket(url, ['mindlog.resp', 'bearer.' + token])`.

## Endpoints

### Health and docs

| Method and path | Response |
|---|---|
| `GET /health` | `{"status":"ok"}` |
| `GET /ready` | `{"status":"ready"}`, or 503 while starting or stopping |
| `GET /metrics` | Prometheus text format |
| `GET /api/openapi.json` | OpenAPI 3.1 |
| `GET /_/*` | The dashboard |

### Agent memory: `POST /api/memory/:op`

Every operation takes a JSON body with `scope: {user, agent?, session?}` and, for superusers, an optional `tenant`. Callers need `memory.read` or `memory.write`.

| `op` | Body (besides `scope`) | Guide |
|---|---|---|
| `remember` | `content`, `kind?`, `source? {type, ref?}`, `async?`, `tags?`, `meta?`, `validFrom?`, `validTo?`, `branch?`, `requestId?`, `toolTrace?` | [Remembering](../guides/memory/remember.md) |
| `recall`, `pack` | `query`, `k?`, `tokenBudget?`, `recipe?`, `inherit?`, `kinds?`, `includeQuarantined?`, `includeCold?`, `explain?`, `asOf?`, `validAt?`, `branch?` | [Recall](../guides/memory/recall.md) |
| `get` | `id`, `asOf?`, `branch?` | |
| `getMany` | `ids` (≤ 100) | |
| `list` | `limit?` (≤ 200), `after?`, `kind?`, `includeForgotten?`, `asOf?`, `branch?` | |
| `forget` | `ids` or `source`, `reason?`, `branch?`, `requestId?` | [Trust](../guides/memory/trust.md) |
| `history` | `id` | [Time travel](../guides/memory/time-travel.md) |
| `graph` | `entity`, `depth?` (1–2) | |
| `scopes` | `limit?` (body without `scope`) | Scopes that hold memory |
| `conflicts` | `status?` (`open`, `all`), `limit?`, `after?` | [Conflicts](../guides/memory/conflicts.md) |
| `resolve` | `id`, `keep` (`a`, `b`, `both`), `validFrom?` | |
| `trust` | `ids`, `trust`, `reason?`, `branch?` | |
| `branch`, `diff`, `drop` | `name` | [Branches](../guides/memory/branches.md) |
| `branches` | — | |
| `merge` | `name`, `policy?` | |
| `pin` | `ids`, `pinned?` (false unpins) | [Lifecycle](../guides/memory/lifecycle.md) |
| `consolidate` | `workers?` | |
| `jobs` | `state?`, `limit?`, `after?` | |
| `export` | `asOf?` → `{data}` (base64 `.mcube`) | [Portability](../guides/memory/portability.md) |
| `import` | `data` (base64), `format?` (`mcube`, `cogx`), `name?` | |

Times are ms since the epoch, or ISO 8601 dates or date-times. `asOf` is `{"time": …}` or `{"index": "…"}`.

### Realtime

| Method and path | Purpose |
|---|---|
| `GET /api/realtime?user=&tenant=&from=` | Memory [change stream](../guides/memory/change-streams.md) over SSE; resumes with `Last-Event-ID` |
| `GET /api/realtime` | Record events: opens the stream (`PB_CONNECT` gives a `clientId`) |
| `POST /api/realtime` | `{clientId, subscriptions}`: set record topics ([Realtime](../guides/app-backend/realtime.md)) |

### Key-value

| Method and path | Body / query | Response |
|---|---|---|
| `GET /api/kv/keys` | `cursor` (default `0`), `match` (glob), `type`, `count` (1–1000) | `{cursor, keys: [{key, encoding, type, ttlMs}]}`; `cursor` is `0` when the scan is complete |
| `GET /api/kv/keys/:key` | `encoding`, `limit` (elements, default 1000) | `{key, type, value, encoding, ttlMs, length, truncated}` |
| `PUT /api/kv/keys/:key` | `{type, value, ttlMs?, encoding?}` | 204; replaces value and TTL in one `MULTI`/`EXEC` |
| `DELETE /api/kv/keys/:key` | | 204, or 404 |
| `PUT /api/kv/keys/:key/ttl` | `{ttlMs}`; `null` removes the expiry | 204, or 404 |

Keys in paths are URL-encoded (`user%3A1`). Binary keys and values travel as base64 with `encoding: "base64"`. Values by type:

| `type` | `value` |
|---|---|
| `string` | `"text"` |
| `hash` | `[{"field": "f", "value": "v"}]` |
| `list` | `["first", "second"]` (in order) |
| `set` | `["member"]` |
| `zset` | `[{"member": "m", "score": 1.5}]` (by score) |
| `json` | Any JSON value |

Collections must not be empty, because Redis deletes empty keys.

### Collections, records, auth and files

| Method and path | Purpose |
|---|---|
| `GET`, `POST /api/collections` | List and create collection schemas (superuser; `X-Mindlog-Tenant`) |
| `GET`, `PATCH`, `DELETE /api/collections/:name` | Read, change, delete a schema |
| `POST /api/collections/rules/check` | Check a rule against a schema |
| `GET`, `POST /api/collections/:c/records` | List (`page`, `perPage`, `filter`, `sort`, `expand`, `fields`, `skipTotal`) and create |
| `GET`, `PATCH`, `DELETE /api/collections/:c/records/:id` | View, update, delete |
| `POST /api/collections/:c/auth-with-password`, `auth-refresh`, `request-otp`, `auth-with-otp`, `auth-with-oauth2`, `request-verification`, `confirm-verification`, `request-password-reset`, `confirm-password-reset` | App-user sign-in and account flows |
| `GET /api/collections/:c/auth-methods` | Sign-in methods offered |
| `GET /api/oauth2-redirect` | OAuth2 redirect target |
| `POST /api/auth/delegate` | API key + user token → delegated token |
| `POST /api/files/token` | Short-lived token for protected files |
| `GET /api/files/:collection/:id/:filename` | Download (`thumb`, `token`) |

Details: [Collections](../guides/app-backend/collections.md), [Authentication](../guides/app-backend/authentication.md), [Files](../guides/app-backend/files.md).

### Administration

| Method and path | Purpose |
|---|---|
| `POST /api/superusers/auth-with-password`, `GET /api/superusers/exists`, `GET /api/superusers/me` | Operator sign-in |
| `GET /api/admin/overview` | Node id, version, uptime, keys, applied index, clients, memory |
| `GET /api/admin/settings` | Effective configuration, secrets replaced |
| `GET /api/admin/logs` | Recent node logs |
| `POST /api/admin/backups` | `{id?}`: back up the ranges this node leads ([Backups](../operations/backups.md)) |
| `GET`, `POST /api/admin/api-keys`, `DELETE /api/admin/api-keys/:id` | API keys across tenants |
| `/api/tenants…` | Tenants, quotas, usage, policies, keys, members, audit, export ([Tenants](../guides/tenants-and-access.md)) |
| `GET /api/cluster/overview`, `POST /api/cluster/actions` | Nodes, ranges, operators; drain, undrain, remove, transfer leader, split ([Deployment](../getting-started/deployment.md#operator-actions)) |
| `GET /api/console` | WebSocket carrying RESP frames, authenticated as the caller |

## Errors

Every error is `application/problem+json` (RFC 9457), from the single error table:

```json
{
  "type": "urn:mindlog:error:invalid-argument",
  "title": "Invalid argument",
  "status": 400,
  "detail": "Request validation failed.",
  "code": "INVALID_ARGUMENT",
  "retryable": false,
  "fields": { "value": "Too small: expected array to have >=1 items" }
}
```

Common statuses: 400 validation, 401 missing or invalid credentials, 403 refused by role or policy, 404 unknown resource, 409 conflict or wrong type, 413 body over 16 MiB, 429 rate limit or quota, 503 not ready or busy. The full mapping is in [Errors](../reference/errors.md).
