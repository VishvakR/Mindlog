import type { Access } from '@mindlog/auth';
import { decide } from '@mindlog/auth';
import type { MindlogError, Result } from '@mindlog/core';
import { err, isUserTenant, mindlogError, ok } from '@mindlog/core';
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
    if (tenant.value?.info.status === 'deleting' && access.role !== 'superuser')
      return err(mindlogError('PERMISSION_DENIED', `tenant ${resource.tenant} is being deleted`));
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

/**
 * Late-bound authorization for the services the tenant registry itself is built
 * on. Refuses everything until the composition root attaches the real check.
 */
export class AccessPorts {
  #authorize: Authorize | undefined;
  #verify: VerifyApiKey | undefined;
  #governor: TenantGovernor | undefined;
  #retention: (() => Promise<ReadonlyArray<{ name: string; days: number }>>) | undefined;

  attach(
    authorize: Authorize,
    verify: VerifyApiKey,
    governor?: TenantGovernor,
    retention?: () => Promise<ReadonlyArray<{ name: string; days: number }>>,
  ): void {
    this.#authorize = authorize;
    this.#verify = verify;
    this.#governor = governor;
    this.#retention = retention;
  }

  admit(tenant: string, cls: AdmitClass): Promise<Result<void, MindlogError>> {
    return this.#governor ? this.#governor.admit(tenant, cls) : Promise.resolve(ok(undefined));
  }

  /** Each registered tenant's audit retention, for the expiry sweep. */
  async tenantRetention(): Promise<ReadonlyArray<{ name: string; days: number }>> {
    return this.#retention ? this.#retention() : [];
  }

  acquireConnection(tenant: string): Promise<Result<() => void, MindlogError>> {
    return this.#governor
      ? this.#governor.acquireConnection(tenant)
      : Promise.resolve(ok(() => undefined));
  }

  spendModel(tenant: string, ms: number): void {
    void this.#governor?.spendModel(tenant, ms);
  }

  authorize(...args: Parameters<Authorize>): ReturnType<Authorize> {
    return this.#authorize
      ? this.#authorize(...args)
      : Promise.resolve(err(mindlogError('PERMISSION_DENIED', 'authorization is not ready')));
  }

  verify(key: string): ReturnType<VerifyApiKey> {
    return this.#verify
      ? this.#verify(key)
      : Promise.resolve(err(mindlogError('UNAUTHENTICATED', 'API keys are not ready')));
  }
}
