# @mindlog/services

Application services (layer `application`): sessions, authentication, and the KV request path shared by every protocol adapter. Adapters parse and serialise; everything else happens here or below (CLAUDE.md §9).

## Public API

| Export | Purpose |
|---|---|
| `KvService` | `openSession(id)`, `execute(session, argv)` → `KvReply`, `authenticate(session, user, password)` |
| `Session` | Per-connection tenant, principal, authentication flag, MULTI queue and WATCHed keys |
| `StaticAuthenticator` | Phase 1 auth: one `default` user with `auth.password`; constant-time comparison |
| `commandName` | Upper-cased command name from argv |

## Request path

```
execute(session, argv)
  ├─ not authenticated and not AUTH        → NOAUTH
  ├─ AUTH / MULTI / EXEC / DISCARD / WATCH / UNWATCH   (session commands)
  ├─ inside MULTI                          → validate (name, arity) and queue → QUEUED
  ├─ read-only command                     → KvReadExecutor on applied state
  └─ write command                         → stamp (ULID + HLC) → Proposer → KvReply
```

## Invariants

- **Authorization before anything else.** With a password configured, only `AUTH` runs before authentication.
- **Writes are proposed, never executed locally**, so every write is durable and replicated before it is acknowledged.
- **Queue-time validation.** An unknown command or wrong arity inside MULTI aborts the EXEC with `EXECABORT`, as in Valkey. Runtime errors stay per command inside the EXEC reply.
- **WATCH compares header versions**, so any change (including create-then-delete) aborts EXEC.
- **Bounded telemetry labels.** Unknown command names are labelled `unknown`.

## Metrics emitted

| Metric | Type | Labels |
|---|---|---|
| `mindlog_kv_command_latency_seconds` | histogram | `command` |
| `mindlog_kv_command_errors_total` | counter | `command`, `code` |

Spans: `kv.<command>` with `mindlog.tenant` and `mindlog.command`.
