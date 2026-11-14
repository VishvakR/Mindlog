---
description: Sign-in for app users (password, OTP, OAuth2), tokens, and delegating a user's access to an agent.
---

# Authentication

App users live in **auth collections**. They sign in with a password, a one-time code by email, or an OAuth2 provider, and get a short-lived access token plus a rotating refresh token.

## Password sign-up and sign-in

```ts
await pb.collection('users').create({ email: 'ann@x.io', password: 'password123', passwordConfirm: 'password123' });
const { token, record } = await pb.collection('users').authWithPassword('ann@x.io', 'password123');
pb.authStore.isValid;    // true; the token is sent on every later call
await pb.collection('users').authRefresh();
```

| Endpoint (`POST /api/collections/:c/…`) | Body |
|---|---|
| `auth-with-password` | `{identity, password}` |
| `auth-refresh` | `{refreshToken?}` (or the current token in `Authorization`) |
| `request-otp` → `auth-with-otp` | `{email}` → `{otpId, password}` |
| `auth-with-oauth2` | `{provider, code, state}` |
| `request-verification` → `confirm-verification` | `{email}` → `{token}` |
| `request-password-reset` → `confirm-password-reset` | `{email}` → `{token, password, passwordConfirm}` |
| `GET …/auth-methods` | Which methods this collection offers |

Sign-in responses are `{token, refreshToken, record}`.

## Tokens

* Access tokens are HS256 JWTs that last **15 minutes**. Refresh tokens rotate on every use.
* Passwords are hashed with **argon2id** on the leader before the write is proposed.
* Changing a user's `tokenKey` (for example on a password reset) revokes all their tokens.
* Sign-in endpoints are rate-limited per client address (`limits.authBurst` 20, `limits.authPerMinute` 30).

## Opt-in methods

OTP, email verification, password reset and OAuth2 are **off by default** (offline-first), and turned on per collection:

```json
"auth": {
  "password": { "enabled": true },
  "otp": { "enabled": true, "durationS": 300, "length": 6 },
  "oauth2": { "enabled": true, "providers": ["google", "github"] },
  "requireVerified": false
}
```

They need node settings:

```yaml
mail:
  mode: smtp            # off | console (prints mail to the log) | smtp
  from: noreply@example.com
  host: smtp.example.com
  port: 587
  username: mailer
  password: ${file:/run/secrets/smtp}
collections:
  appUrl: https://app.example.com     # for links in verification and reset mail
auth:
  oauth2:
    - { name: google, clientId: '…', clientSecret: '…' }
    - { name: github, clientId: '…', clientSecret: '…' }
    - { name: corp, clientId: '…', clientSecret: '…', issuer: 'https://login.example.com' }   # any OIDC issuer
```

OAuth2 uses PKCE. The provider redirects to `GET /api/oauth2-redirect`.

## Delegating to an agent

An assistant agent should act **for** a user, with that user's rights, and not with its own API key's rights. Delegation combines both credentials into a token that records the user as the principal and the agent as the actor:

```ts
// the agent holds its API key; the user handed it their access token
const delegated = await client.delegate('mlk_…', userToken);
client.authStore.save(delegated, null);
const todos = await client.collection('todos').getFullList();   // filtered by the user's rules
```

`POST /api/auth/delegate` with `Authorization: Bearer mlk_…` and `{userToken}` returns `{token, expiresIn}`. Both identities appear in the [audit log](../tenants-and-access.md#audit-log).

## Superusers

Superusers are operators, not app users. They sign in with `POST /api/superusers/auth-with-password` (tokens last one day) and bypass collection rules. Create them with `mindlog-server superuser upsert` while the node is stopped. Tenant members (dashboard accounts limited to one tenant) are managed under [Tenants](../tenants-and-access.md).
