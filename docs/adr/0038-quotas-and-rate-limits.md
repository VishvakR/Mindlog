# ADR-0038: Tenant quotas and rate limits

- Status: accepted
- Date: 2026-11-09
- PLAN: 18.3, 20 (runaway tenant), 24 phase 10
- References: tikv-pd.md, [ADR-0036](0036-tenants-and-rbac.md)

## Context

One tenant must not be able to starve another. A central counter on the request path would be a hot spot and a single point of failure.

## Decision

- `TenantGovernor` admits a request before it is routed: storage, key and memory quotas reject growth with `QUOTA_EXCEEDED`; write and recall rates reject with `RATE_LIMITED`. Deletes and forgets are always admitted, so a full tenant can make room.
- **Rates** are token buckets held per node. Each store reports per-tenant demand in `StoreStats.tenants`, and PD answers with that node's `share` of the limit: an equal 10% floor split between live stores, and the rest by demand. Shares of a tenant sum to 1. This is soft state; a node that has not heard from PD uses a share of 1.
- **Usage** is approximate. Each node samples the ranges it leads (so a range counts once): bytes from LevelDB's `approximateSize`, keys and memories from a capped key walk. PD sums them. Only tenants with such a quota are measured.
- **Model time** is measured around each model call on the node that runs it, and charged to the tenant from an `AsyncLocalStorage` set when the operation starts.
- A tenant with no registry row or no quotas skips all of this.

## Alternatives considered

- **Replicated counters in apply**: exact, but they add a write to every command and do not survive a split without extra work.
- **An equal share per node, with no PD involvement**: a tenant whose clients all reach one node would get a fraction of its limit.

## Consequences

- Quotas can be overshot by up to one sampling interval (30 s) of writes.
- `approximateSize` reports compressed on-disk bytes and lags the memtable.
- Past the walk's cap, key and memory counts under-report.
- A node that lost PD keeps its last shares; one that never heard from PD can admit up to the whole limit by itself.
- Connection quotas count key-bound RESP sessions only.
