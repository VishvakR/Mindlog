import type { Access } from '@mindlog/auth';
import { decide } from '@mindlog/auth';
import type { MindlogError, Result } from '@mindlog/core';
import { err, isUserTenant, mindlogError, ok } from '@mindlog/core';
import type { RedactionKind } from '@mindlog/memory';
import type { AuditEvent } from '../audit/audit-service.js';
import type { Authorize } from './authorize.js';
import type { AdmitClass, TenantGovernor } from './governor.js';
import type { TenantRecord } from './tenant-service.js';

/**
 * Combines `decide` with the tenant's replicated rows (PLAN 18.2). Fails
 * closed: if the tenant row cannot be read the request is refused.
 */
export class AccessControl {
  constructor(
    private readonly tenants: {
      cached(name: string): Promise<Result<TenantRecord | undefined, MindlogError>>;
    },
    /** Told about each refusal, for the audit log. */
    private readonly onDeny?: (event: AuditEvent) => void,
  ) {}

  readonly check: Authorize = async (access, action, resource) => {
    if (!access) return err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'));
    const tenant = await this.tenants.cached(resource.tenant);
    if (!tenant.ok) return tenant;
    const status = tenant.value?.info.status ?? 'active';
    if (status !== 'active' && access.role !== 'superuser')
      return err(mindlogError('PERMISSION_DENIED', `tenant ${resource.tenant} is ${status}`));
    const decision = decide(access, action, resource, tenant.value?.policies ?? []);
    if (decision.allow) return ok(undefined);
    // A reserved tenant has no audit family a caller could read; drop those.
    if (isUserTenant(resource.tenant))
      this.onDeny?.({
        tenant: resource.tenant,
        principal: access.subject,
        action,
        resource: resource.scope ? `user:${resource.scope}` : `tenant:${resource.tenant}`,
        ok: false,
        detail: decision.reason,
      });
    return err(mindlogError('PERMISSION_DENIED', decision.reason));
  };
}

export type VerifyApiKey = (
  key: string,
) => Promise<Result<{ access: Access; tenant: string }, MindlogError>>;

/** What the composition root plugs in once the tenant registry exists. */
export interface TenantPorts {
  readonly authorize: Authorize;
  readonly verify: VerifyApiKey;
  readonly governor?: TenantGovernor;
  readonly tenant?: (name: string) => Promise<Result<TenantRecord | undefined, MindlogError>>;
  readonly retention?: () => Promise<ReadonlyArray<{ name: string; days: number }>>;
}

/**
 * Late-bound authorization for the services the tenant registry itself is built
 * on. Refuses everything until the composition root attaches the real check.
 */
export class AccessPorts {
  #ports: TenantPorts | undefined;

  attach(ports: TenantPorts): void {
    this.#ports = ports;
  }

  authorize(...args: Parameters<Authorize>): ReturnType<Authorize> {
    return this.#ports
      ? this.#ports.authorize(...args)
      : Promise.resolve(err(mindlogError('PERMISSION_DENIED', 'authorization is not ready')));
  }

  verify(key: string): ReturnType<VerifyApiKey> {
    return this.#ports
      ? this.#ports.verify(key)
      : Promise.resolve(err(mindlogError('UNAUTHENTICATED', 'API keys are not ready')));
  }

  admit(tenant: string, cls: AdmitClass): Promise<Result<void, MindlogError>> {
    const governor = this.#ports?.governor;
    return governor ? governor.admit(tenant, cls) : Promise.resolve(ok(undefined));
  }

  /** What the tenant's memories are redacted for; none until the registry is attached. */
  async redaction(tenant: string): Promise<readonly RedactionKind[]> {
    const record = await this.#ports?.tenant?.(tenant);
    const policy = record?.ok ? record.value?.info.redaction : undefined;
    return policy?.enabled ? policy.kinds : [];
  }

  /** Each registered tenant's audit retention, for the expiry sweep. */
  async tenantRetention(): Promise<ReadonlyArray<{ name: string; days: number }>> {
    return (await this.#ports?.retention?.()) ?? [];
  }

  acquireConnection(tenant: string): Promise<Result<() => void, MindlogError>> {
    const governor = this.#ports?.governor;
    return governor ? governor.acquireConnection(tenant) : Promise.resolve(ok(() => undefined));
  }

  spendModel(tenant: string, ms: number): void {
    void this.#ports?.governor?.spendModel(tenant, ms);
  }
}
