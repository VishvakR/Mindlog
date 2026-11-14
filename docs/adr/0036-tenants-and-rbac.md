# ADR-0036: Tenants and role-based access

- Status: accepted
- Date: 2026-11-09
- PLAN: 18.2, 18.3 (roles, policies, tenants), 24 phase 10
- References: opa.md, [ADR-0024](0024-http-adapter-and-superusers.md), [ADR-0035](0035-app-auth.md)

## Context

Until now a credential was either a superuser or an API key limited to memory, RESP sessions were always tenant `default`, and memory REST took its tenant from the request body. Isolation between tenants needs one decision point that every interface goes through.

## Decision

- **`decide(access, action, resource, policies)`** in `@mindlog/auth` is pure and the only place roles, tenants and policy rows combine. It returns a reason with every answer.
- **Built-in roles** are the six of PLAN 18.2. **Policy rows** are per-tenant data (allow or deny, subject a role or principal, actions, optional scope patterns). A deny row beats everything. No row can cross a tenant, reach a reserved tenant, grant a superuser-only action, or give an agent an admin action.
- **The tenant registry** is rows in `$system` written through the normal proposal path. A tenant that was never registered is active with no limits, so existing single-tenant setups keep working.
- **Enforcement lives in the application layer**: `MemoryService.#execute`, `KvService.#dispatch` and `AccessControl`, reached from HTTP, RESP and MCP. A request forwarded between nodes is not re-checked; the entry node decided.
- **The tenant comes from the credential.** Only a superuser may name another tenant. `AUTH mlk_…` binds a RESP session to the key's tenant and role.
- **API keys** carry a role (default `agent`), scope patterns and an expiry; keys made before this ADR act as agents with their old user pin.
- **Dashboard accounts** are the superuser table with an optional `(role, tenant)`. A row with no tenant is a superuser. Writes use `WATCH` so a tenant admin cannot take over a superuser's or another tenant's account by email.
- Request paths cache a tenant row for two seconds.

## Alternatives considered

- **Embedding OPA or Rego**: a second language and runtime for a table and a handful of rules. We keep OPA's ideas: policy as data and an explained decision.
- **A role field per interface**: three places to get wrong.

## Consequences

- A policy or status change takes up to two seconds to reach a node's request path. An API key revocation is immediate, because keys are read on every request.
- Key-bound RESP sessions may only run their own connection and memory commands; `CLUSTER.*` and `CONFIG` need the static password or a superuser.
- The static RESP password keeps full access to tenant `default`; the production profile must configure it deliberately.
