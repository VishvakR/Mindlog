import type { Clock, Logger, MindlogError, Result } from '@mindlog/core';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import type { BlobStore } from '@mindlog/blob';
import { replies } from '@mindlog/kv';
import type { KvReply } from '@mindlog/proto';
import type { CommandStamper } from '@mindlog/statemachine';
import type { AuditEvent } from '../audit/audit-service.js';
import type { Placement, RangeCall, RangeRouter, RangeTarget } from '../kv/range-router.js';
import type { TenantService } from './tenant-service.js';

export const TENANT_OP_PREFIX = 'tenant.';
const PURGE_OP = `${TENANT_OP_PREFIX}purge`;
const LIMIT = 1_000;
const MAX_RETRIES = 4;
const RETRYABLE = new Set(['NOT_LEADER', 'RANGE_MOVED', 'UNAVAILABLE']);
/** Where the node keeps a tenant's blobs: cold segments, files, thumbnails, exports. */
const BLOB_ROOTS = ['cold', 'files', 'thumbs', 'exports'];

export interface TenantPurgerDeps {
  readonly tenants: TenantService;
  readonly router: RangeRouter;
  readonly stamper: CommandStamper;
  readonly clock: Clock;
  readonly logger: Logger;
  /** How long a deleted tenant waits before its data goes (an operator's chance to undo). */
  readonly graceMs: number;
  readonly blob?: BlobStore;
  /** Whether this node's store still holds any key of the tenant. */
  readonly holdsTenant: (tenant: string) => Promise<boolean>;
  /** Destroys this node's data keys of the tenant (ADR-0014); a no-op without encryption. */
  readonly forgetKeys: (tenant: string) => Promise<void>;
  readonly audit: (event: AuditEvent) => void;
}

/**
 * The tenant deletion workflow (PLAN 18.3, 24 phase 10). A deleting tenant is
 * refused every request; after the grace period every range is purged in
 * batches until a whole pass removes nothing, then its blobs go and it is
 * marked deleted. Each node then shreds its own data keys once its store
 * holds nothing of the tenant. Every step is idempotent, so any node may run
 * it, and a crash just means the next tick does it again.
 */
export class TenantPurger {
  #running = false;

  constructor(private readonly deps: TenantPurgerDeps) {}

  async tick(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const listed = await this.deps.tenants.list();
      if (!listed.ok) return;
      const now = Number(this.deps.clock.now());
      for (const t of listed.value) {
        if (
          t.status === 'deleting' &&
          t.deletingAt &&
          Date.parse(t.deletingAt) + this.deps.graceMs <= now
        )
          await this.#purge(t.name);
        if (t.status === 'deleted' && !(await this.deps.holdsTenant(t.name)))
          await this.deps.forgetKeys(t.name);
      }
    } catch (cause) {
      this.deps.logger.warn('tenant purge failed; retrying on the next tick', { err: cause });
    } finally {
      this.#running = false;
    }
  }

  async #purge(tenant: string): Promise<void> {
    const ranges = await this.deps.router.ranges();
    if (!ranges.ok) return;
    let total = 0;
    for (const placement of ranges.value) {
      for (;;) {
        const done = await this.#purgeRange(placement, tenant);
        if (!done.ok) {
          this.deps.logger.warn('tenant purge step failed', { tenant, error: done.error.message });
          return;
        }
        total += done.value;
        if (done.value < LIMIT) break;
      }
    }
    // A pass that removed anything may have raced a split or a late write: confirm with a clean one.
    if (total > 0) return;
    for (const root of BLOB_ROOTS) {
      const listed = await this.deps.blob?.list(`${root}/${tenant}`);
      if (listed?.ok) for (const key of listed.value) await this.deps.blob?.delete(key);
    }
    const marked = await this.deps.tenants.markDeleted(tenant);
    if (!marked.ok) return;
    // Recorded in `$system`: the tenant's own audit family is gone.
    this.deps.audit({
      tenant: SYSTEM_TENANT,
      principal: 'system:purger',
      action: 'tenant.purged',
      resource: `tenant:${tenant}`,
      ok: true,
    });
  }

  async #purgeRange(placement: Placement, tenant: string): Promise<Result<number, MindlogError>> {
    let current = placement;
    for (let attempt = 0; ; attempt++) {
      const result = current.local
        ? await this.#propose(current.local, tenant)
        : await this.#forward(current, tenant);
      if (result.ok || !RETRYABLE.has(result.error.code) || attempt >= MAX_RETRIES) return result;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      if (this.deps.router.refresh) {
        const again = await this.deps.router.refresh(current);
        if (again.ok) current = again.value;
      }
    }
  }

  async #propose(target: RangeTarget, tenant: string): Promise<Result<number, MindlogError>> {
    const command = this.deps.stamper.stamp(SYSTEM_TENANT, 'system:purger', {
      case: 'tenantPurge',
      value: { tenant, limit: LIMIT },
    });
    const proposed = await target.proposer.propose(command);
    if (!proposed.ok) return proposed;
    const { outcome } = proposed.value.result;
    if (outcome.case === 'error')
      return err(mindlogError(outcome.value.code as MindlogError['code'], outcome.value.message));
    return countOf(outcome.case === 'kv' ? outcome.value : undefined);
  }

  async #forward(placement: Placement, tenant: string): Promise<Result<number, MindlogError>> {
    const reply = await this.deps.router.forward(
      placement,
      { tenant: SYSTEM_TENANT, principal: 'system:purger' },
      { kind: 'memory', op: PURGE_OP, json: JSON.stringify({ tenant }) },
    );
    if (!reply.ok) return reply;
    return countOf(reply.value);
  }

  /** Runs a purge step another node forwarded here. */
  async forwarded(rangeId: bigint, call: RangeCall): Promise<KvReply> {
    if (call.kind !== 'memory' || call.op !== PURGE_OP)
      return replies.error('INVALID_ARGUMENT', 'not a tenant call');
    const target = this.deps.router.local(rangeId);
    if (!target)
      return replies.error('RANGE_MOVED', `this node holds no replica of range ${String(rangeId)}`);
    const { tenant } = JSON.parse(call.json) as { tenant: string };
    const done = await this.#propose(target, tenant);
    return done.ok
      ? replies.integer(done.value)
      : replies.error(done.error.code, done.error.message);
  }
}

function countOf(reply: KvReply | undefined): Result<number, MindlogError> {
  if (reply?.kind.case === 'error')
    return err(
      mindlogError(reply.kind.value.code as MindlogError['code'], reply.kind.value.message),
    );
  return reply?.kind.case === 'integer'
    ? ok(Number(reply.kind.value))
    : err(mindlogError('INTERNAL', 'tenant purge gave no count'));
}
