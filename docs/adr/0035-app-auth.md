# ADR-0035: App authentication: argon2id, JWTs, sessions and delegated agent tokens

- Status: accepted
- Date: 2026-11-03
- PLAN: 16.4 (authentication; amended), 16.8 (hooks), 18 (principal and actor)
- References: [pocketbase.md](../references/pocketbase.md) (`core/record_tokens.go`, `apis/record_auth_*.go`), [ADR-0024](0024-http-adapter-and-superusers.md)

## Context

Auth collections need end-user signup and login, short-lived access tokens, refresh tokens, revocation, and agents that act for a user. Mindlog runs fully offline, so email and third-party identity providers are not always reachable. Superusers already have HMAC tokens with a per-user `tokenKey` (ADR-0024).

## Decision

- **Passwords**: argon2id via Node's built-in `crypto.argon2` (memory 19 MiB, 2 passes, parallelism 1), hashed on the leader before proposing, never in apply. A dummy hash keeps failed logins as slow as real ones.
- **Access tokens**: JWT HS256 (`header.payload.signature`) on `node:crypto`, 15 minutes, with claims `{sub, col, ten, typ, act?, exp, iat}` and a `kid` header. The HMAC key is `keySecret ‖ record.tokenKey`. The key set lives in `$system` settings; rotation adds a key and keeps the previous one for verification. Changing a user's `tokenKey` revokes all its tokens.
- **Refresh tokens**: random 32 bytes, stored as sha256 in the system collection `_sessions`, 30 days, rotated on each use.
- **Delegated agent tokens**: `POST /api/auth/delegate` with an API key (Bearer) and a user's access token returns a 15-minute JWT whose principal is the user and whose `act` is the API key id. Rules evaluate as the user; commands record `principal = user` and `actor = agent`. An API key pinned to another user is refused.
- **Opt-in methods** (off by default, per auth collection): OTP by email (codes hashed in `_otps`, 5 minutes, 5 attempts) and OAuth2 (generic OIDC with PKCE S256, Google and GitHub presets; links in `_externalAuths`; `state` and `verifier` carried in a short-lived signed token). Email verification and password reset need the mailer too. The mailer is our own SMTP client (EHLO, STARTTLS, AUTH, DATA) or a console mailer for development.
- **Hooks** run in a `worker_threads` Worker with `resourceLimits` and a per-call timeout. This bounds time and memory; it is **not** a security boundary — hooks are code the operator installs.

## Alternatives considered

- **`jose`, `argon2`, `nodemailer`, `openid-client`**: four dependencies for code we can write in a few hundred lines on `node:crypto`, `node:net` and `fetch`.
- **Session cookies**: CSRF; PocketBase and its SDK use bearer tokens.

## Consequences

- OTP and OAuth2 are tested against an in-process fake SMTP server and a fake OIDC provider only.
- Hooks must be trusted code.
- JWT verification needs the key set on every node; it is read from replicated `$system` settings.
