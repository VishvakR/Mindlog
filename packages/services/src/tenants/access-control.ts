import type { Access } from '@mindlog/auth';
import { decide } from '@mindlog/auth';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import type { Authorize } from './authorize.js';
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
  ) {}

  readonly check: Authorize = async (access, action, resource) => {
    if (!access) return err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'));
    const tenant = await this.tenants.cached(resource.tenant);
    if (!tenant.ok) return tenant;
    if (tenant.value?.info.status === 'deleting' && access.role !== 'superuser')
      return err(mindlogError('PERMISSION_DENIED', `tenant ${resource.tenant} is being deleted`));
    const decision = decide(access, action, resource, tenant.value?.policies ?? []);
    return decision.allow ? ok(undefined) : err(mindlogError('PERMISSION_DENIED', decision.reason));
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

  attach(authorize: Authorize, verify: VerifyApiKey): void {
    this.#authorize = authorize;
    this.#verify = verify;
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
