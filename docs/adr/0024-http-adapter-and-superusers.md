# ADR-0024: HTTP adapter on Fastify; superusers in the system tenant with bearer tokens

- Status: accepted
- Date: 2026-10-12
- PLAN: 15.3 (REST), 17.3 (dashboard security), 18, 24 phase 2
- References: pocketbase.md (`core/record_tokens.go`,
  `apis/record_auth_with_password.go`, `apis/base.go` `Static`)

## Context

Phase 2 needs a REST API (`/api/kv/*`), health and metrics endpoints, RFC 9457 errors, an
OpenAPI document and an admin login for the dashboard, bootstrapped from the CLI. The error table
in `@mindlog/core` already maps every `MindlogErrorCode` to an HTTP status. Everything that must
survive a restart and agree across replicas lives in the replicated log (ADR-0003).

## Decision

- **Fastify** hosts `/health`, `/ready`, `/metrics`, `/api/*` and the dashboard at `/_/`.
  Request schemas are Zod v4 schemas exported by `@mindlog/services`; OpenAPI 3.1 is assembled
  from them with `z.toJSONSchema` (no swagger plugin).
- **Errors** are `application/problem+json` (RFC 9457): `type` = `problemType(code)`, `status` =
  `ERROR_CODES[code].httpStatus`, `title`, `detail`, `code`, `retryable`.
- **Superusers** are KV hashes in the system tenant (`$system`), key `superuser:<email>`, with
  fields `email`, `passwordHash` (scrypt, N=16384, r=8, p=1, 16-byte salt), `tokenKey`,
  `created`, `updated`. A node-wide `authSecret` lives in the hash `settings:auth`. They are
  written with ordinary argv commands (ADR-0021) proposed by `AdminService`, so no new command
  type or on-disk format is needed. Random values (salt, `tokenKey`, secret) are generated on the
  proposer before proposing, so apply stays deterministic. KV apply accepts argv writes in `$system`
  (user tenants plus `$system`; `$node` stays refused). RESP sessions use the default tenant and
  cannot reach `$system`.
- **Tokens** are `base64url(payload).base64url(HMAC-SHA256(authSecret + tokenKey, payload))`,
  payload `{sub: email, exp}`. Changing a password rotates `tokenKey`, revoking old tokens. The
  dashboard sends `Authorization: Bearer`; there are no cookies, so no CSRF surface. The
  WebSocket console authenticates with the `Sec-WebSocket-Protocol` header (`bearer.<token>`).
- **Bootstrap**: `mindlog-server superuser upsert <email> <password>` opens the data directory
  (the server must be stopped) and proposes the writes through the same service.

## Alternatives considered

- **New typed command bodies for superusers**: explicit, but a proto change for data that
  argv-encoded hashes already express.
- **JWT library**: interoperable, but a dependency and algorithm-choice surface for a token only
  this server reads.
- **Cookie sessions**: need CSRF tokens and SameSite handling (PLAN 17.3).
- **`@fastify/swagger` + a Zod type provider**: more dependencies for what `z.toJSONSchema` gives.

## Consequences

- Superuser records replicate with the log once Raft lands (phase 3) with no extra work.
- Phase 10 (`@mindlog/auth`: users, roles, API keys, MFA) will move superusers behind an
  `Authenticator` port; the key layout above is the migration source.
- Login rate limiting and TOTP are not in phase 2 (tracked in `docs/phases/phase-2.md`).
