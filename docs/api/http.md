# HTTP API

Served by `@mindlog/adapter-http` on `listen.http` (default `0.0.0.0:8090`), ADR-0024. The live OpenAPI 3.1 document is `GET /api/openapi.json`; it is built from the same Zod schemas that validate requests.

## Authentication

1. Create a superuser while the server is stopped:
   `mindlog-server superuser upsert you@example.com 'a long password' --data-dir ./data`
2. `POST /api/superusers/auth-with-password` with `{"email", "password"}` returns `{"token", "superuser"}`.
3. Send `Authorization: Bearer <token>` on every `/api/*` call. Tokens last one day; resetting the password revokes them.

The WebSocket console cannot set headers, so it sends the token as a subprotocol: `new WebSocket(url, ['mindlog.resp', 'bearer.' + token])`.

## Endpoints

| Method and path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /health` | — | | `{"status": "ok"}` |
| `GET /ready` | — | | `{"status": "ready"}`, or 503 while starting or stopping |
| `GET /metrics` | — | | Prometheus text format |
| `POST /api/superusers/auth-with-password` | — | `{email, password}` | `{token, superuser}` |
| `GET /api/superusers/exists` | — | | `{exists}` |
| `GET /api/superusers/me` | bearer | | `{email, created, updated}` |
| `GET /api/kv/keys` | bearer | `cursor` (default `0`), `match` (glob), `type`, `count` (1–1000) | `{cursor, keys: [{key, encoding, type, ttlMs}]}`; `cursor` is `0` when the scan is complete |
| `GET /api/kv/keys/:key` | bearer | `encoding` of the key, `limit` (elements, default 1000) | `{key, type, value, encoding, ttlMs, length, truncated}` |
| `PUT /api/kv/keys/:key` | bearer | `{type, value, ttlMs?, encoding?}` | 204; replaces value and TTL in one `MULTI`/`EXEC` |
| `DELETE /api/kv/keys/:key` | bearer | | 204, or 404 |
| `PUT /api/kv/keys/:key/ttl` | bearer | `{ttlMs}`; `null` removes the expiry | 204, or 404 |
| `GET /api/admin/overview` | bearer | | Node id, version, uptime, keys, applied index, clients, memory |
| `GET /api/admin/settings` | bearer | | Effective configuration, secrets replaced |
| `POST /api/admin/backups` | bearer | `{id?}`; give every node the same id | `{id, ranges}`: the ranges this node led and wrote (ADR-0041) |
| `GET /api/console` | bearer (subprotocol) | WebSocket, binary RESP frames both ways | A RESP connection authenticated as the superuser |
| `GET /api/openapi.json` | — | | OpenAPI 3.1 |
| `GET /_/*` | — | | The dashboard |

Keys in paths are URL-encoded (`user%3A1`, `a%2Fb`). Binary keys and values travel as base64 with `encoding: "base64"`.

### Values by type

| `type` | `value` |
|---|---|
| `string` | `"text"` |
| `hash` | `[{"field": "f", "value": "v"}]` |
| `list` | `["first", "second"]` (in order) |
| `set` | `["member"]` |
| `zset` | `[{"member": "m", "score": 1.5}]` (by score) |
| `json` | Any JSON value |

Collections must not be empty, because Redis deletes empty keys.

## Errors

Every error is `application/problem+json` (RFC 9457), from the error table in `@mindlog/core`:

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

Common statuses: 400 validation, 401 missing or invalid token, 404 unknown key or route, 409 wrong type, 413 body over 16 MiB, 503 not ready or busy.
