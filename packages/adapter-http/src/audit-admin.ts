import type { FastifyRequest } from 'fastify';
import { principalOf } from '@mindlog/auth';
import { SYSTEM_TENANT } from '@mindlog/core';
import type { HttpServerDeps } from './http-deps.js';

const ADMIN_ROUTE = /^\/api\/(tenants|admin\/api-keys)/;

/** Records a change made through the admin routes (PLAN 18.5): who, on what, and whether it worked. */
export function auditAdminChange(
  request: FastifyRequest,
  status: number,
  deps: HttpServerDeps,
): void {
  const route = request.routeOptions.url ?? '';
  if (!deps.audit || request.method === 'GET' || !ADMIN_ROUTE.test(route)) return;
  const params = request.params as Record<string, string>;
  // Deleting a tenant also deletes its audit family, so that request is kept in `$system`.
  const deletion = request.method === 'DELETE' && route === '/api/tenants/:tenant';
  const tenant = deletion ? SYSTEM_TENANT : (params.tenant ?? request.who?.tenant);
  if (!tenant) return;
  deps.audit.record({
    tenant,
    principal: request.who
      ? principalOf(request.who.identity)
      : `superuser:${request.superuser?.email ?? ''}`,
    action: `${request.method} ${route}`,
    resource: `tenant:${params.tenant ?? tenant}`,
    ok: status < 400,
  });
}
