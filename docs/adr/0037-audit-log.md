# ADR-0037: Audit log through a range-local outbox

- Status: accepted
- Date: 2026-11-09
- PLAN: 18.5, 24 phase 10
- References: [opa.md](../references/opa.md), [ADR-0036](0036-tenants-and-rbac.md)

## Context

An audit row must be atomic with the change it describes, but a command may only write keys inside its own range, and a tenant's audit family is usually in another range.

## Decision

- Security-relevant commands (`MemoryForget`, `ConflictResolve`, `MemoryTrust`, `BranchMerge`, `BranchDrop`, `SchemaChange`, `TenantPurge`) write a **range-local outbox row** in the same batch as the change. Snapshots carry range-local rows; a merge hook moves the right range's rows to the left.
- Each range's leader drains its outbox: `AuditAppend` places the records in the tenant's family at `tenant·s·('audit-<day>', atMs, id)`, and `AuditOutboxAck` removes the drained rows. A drain interrupted between the two repeats and writes the same keys.
- The day in the first tuple element gives the split chooser a boundary, so the family can spread over ranges.
- Events with no command (refused requests, failed logins, admin changes made through `$system` writes) go through a bounded in-memory queue into `AuditAppend`. They can be lost on a crash or when the queue overflows; overflow is counted in `mindlog_audit_dropped_total`.
- Retention is the replicated `AuditExpire`, swept hourly per tenant. Reads walk days newest first with a `day:key` cursor.
- Proposing audit bodies waits for cluster version 10.

## Alternatives considered

- **Writing the audit row inside the command, into the tenant's family**: out of span, so snapshots drop it and range checks would refuse it.
- **Audit rows under each scope's own prefix**: no outbox, but a tenant-wide read would have to merge every scope.

## Consequences

- Audit rows appear about a second after the change.
- Admin changes are audited after they succeed, not atomically with them.
- Failed logins are stored under `$system`, which only superusers can read; they record the address, never the password.
