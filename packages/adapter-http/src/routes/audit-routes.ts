import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { accessOf } from '@mindlog/auth';
import { SYSTEM_TENANT, err, mindlogError, ok } from '@mindlog/core';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(512).optional(),
});

const entry = z.object({
  id: z.string(),
  tenant: z.string(),
  principal: z.string(),
  actor: z.string(),
  action: z.string(),
  resource: z.string(),
  ok: z.boolean(),
  detail: z.string(),
  atMs: z.number(),
});

const DEFAULT_RETENTION_DAYS = 90;

/** The audit log, newest first (PLAN 18.5). */
export function auditRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/tenants/:tenant/audit',
      summary: 'The tenant’s audit log, newest first, by cursor',
      tag: 'tenants',
      auth: 'identity',
      query: querySchema,
      response: z.object({ items: z.array(entry), cursor: z.string().optional() }),
    },
    async ({ who, params, query }) => {
      if (!who) return err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'));
      if (!deps.audit) return err(mindlogError('UNIMPLEMENTED', 'audit is not available'));
      const tenant = params.tenant ?? '';
      // `$system` holds failed logins: reserved for every other action, readable by superusers.
      const allowed =
        tenant === SYSTEM_TENANT && who.identity.kind === 'superuser'
          ? ok(undefined)
          : await deps.access.check(accessOf(who.identity), 'audit.read', { tenant });
      if (!allowed.ok) return allowed;
      const info = await deps.tenants.cached(tenant);
      if (!info.ok) return info;
      const page = await deps.audit.read(tenant, {
        limit: query.limit,
        ...(query.cursor ? { cursor: query.cursor } : {}),
        retentionDays: info.value?.info.auditRetentionDays ?? DEFAULT_RETENTION_DAYS,
      });
      return page.ok ? ok(page.value) : page;
    },
  );
}
