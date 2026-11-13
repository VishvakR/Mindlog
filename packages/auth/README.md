# @mindlog/auth

End-user authentication for full-stack mode (PLAN 16.4, ADR-0035). Building blocks only; `@mindlog/services` (`AppAuthService`) stores users, sessions and codes in collections and decides who may do what.

## Public API

- `hashPassword` / `verifyPassword`: argon2id via Node's built-in `crypto.argon2` (19 MiB, 2 passes, 1 lane), PHC strings, constant-time compare; an empty hash checks against a dummy so unknown users take as long.
- `signJwt` / `readJwt` / `verifyJwt`: HS256 JWTs with a `kid` header. The signing key is the key set's secret joined with the record's `tokenKey`, so rotating `tokenKey` revokes every token of the user. Token types (`access`, `delegated`, `file`, `verify`, `reset`, `oauth2`) are never interchangeable.
- `Identity` (`anonymous`, `superuser`, `record`, `apiKey`, `delegated`) with `principalOf` / `actorOf` for `Command.principal` and `Command.actor`.
- `RateLimiter`: bounded token buckets per client key, with an optional per-call rate (the tenant governor's buckets).
- Authorization (PLAN 18.2, ADR-0036): `decide(access, action, resource, policies)` → `Decision` (`allow`, `reason`). Pure: a built-in role → action table for `ROLES` (`superuser`, `tenant_admin`, `developer`, `agent`, `app_user`, `readonly`) and `ACTIONS`, then the tenant's `PolicyRow`s (allow or deny, by role or principal, with a scope pattern; `matchesScope` handles `*`). Deny wins; superuser-only actions (tenant create, delete and quotas, cluster) cannot be granted; agents never get admin actions.
- `recordId`, `otpCode`, `randomSecret`, `sha256`.
- Opt-in (off unless configured):
  - `Mailer` port with `SmtpMailer` (our own client over `node:net`/`node:tls`: EHLO, STARTTLS, AUTH PLAIN, dot-stuffing, header-injection checks) and `ConsoleMailer` for development.
  - OAuth2: `google`, `github` presets, `discoverOidc` for any OpenID Connect issuer, `pkce` (S256), `authorizeUrl`, `exchangeCode` (code + verifier → user info).

## Invariants

- No secret, password or code is logged (the console mailer logs only when configured for development).
- OTP codes and refresh tokens are stored as sha256, never in clear.
- `decide` fails closed: what neither the role table nor an allow row grants is refused, and every refusal carries its reason. A reserved tenant (`$system`, `$node`) is never reachable.

## Metrics

None; the services count logins and failures.
