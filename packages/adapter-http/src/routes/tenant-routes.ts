import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Action } from '@mindlog/auth';
import { accessOf } from '@mindlog/auth';
import type { MindlogError, Result } from '@mindlog/core';
import { err, mindlogError, ok } from '@mindlog/core';
import {
  apiKeyInputSchema,
  createTenantSchema,
  memberInputSchema,
  policiesSchema,
  quotasSchema,
  superuserSchema,
  tenantSchema,
  tenantSettingsSchema,
} from '@mindlog/services';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec, Who } from '../route.js';
import { defineRoute } from '../route.js';

const keyInfo = z.object({
  id: z.string(),
  tenant: z.string(),
  user: z.string().optional(),
  name: z.string(),
  role: z.string(),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.number().optional(),
  created: z.string(),
});

/** A key created through a tenant's own route names no tenant: the path does. */
const tenantKeyInput = apiKeyInputSchema.omit({ tenant: true });

/** The tenant registry and each tenant's own administration (PLAN 18.2, 18.3). */
export function tenantRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  const check = (who: Who | undefined, action: Action, tenant: string) =>
    who
      ? deps.access.check(accessOf(who.identity), action, { tenant })
      : Promise.resolve(err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.')));
  const guarded = async <T>(
    who: Who | undefined,
    action: Action,
    tenant: string,
    run: () => Promise<Result<T, MindlogError>>,
  ): Promise<Result<T, MindlogError>> => {
    const allowed = await check(who, action, tenant);
    return allowed.ok ? run() : allowed;
  };
  const tenantOf = (params: Readonly<Record<string, string>>) => params.tenant ?? '';
  const noKeys = () =>
    err(mindlogError('UNIMPLEMENTED', 'API keys are not available on this node'));
  const common = { tag: 'tenants', auth: 'identity' as const };

  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'GET',
      path: '/api/tenants',
      summary: 'Registered tenants: all for a superuser, its own for anyone else',
      response: z.object({ tenants: z.array(tenantSchema) }),
    },
    async ({ who }) => {
      if (who?.identity.kind === 'superuser') {
        const listed = await deps.tenants.list();
        return listed.ok ? ok({ tenants: listed.value }) : listed;
      }
      const name = who?.tenant ?? '';
      const allowed = await check(who, 'tenant.read', name);
      if (!allowed.ok) return allowed;
      const one = await deps.tenants.get(name);
      if (one.ok) return ok({ tenants: [one.value] });
      return one.error.code === 'NOT_FOUND' ? ok({ tenants: [] }) : one;
    },
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'POST',
      path: '/api/tenants',
      summary: 'Register a tenant with its quotas',
      body: createTenantSchema,
      response: tenantSchema,
    },
    ({ who, body }) => guarded(who, 'tenant.create', body.name, () => deps.tenants.create(body)),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'GET',
      path: '/api/tenants/:tenant',
      summary: 'One tenant',
      response: tenantSchema,
    },
    ({ who, params }) =>
      guarded(who, 'tenant.read', tenantOf(params), () => deps.tenants.get(tenantOf(params))),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'PATCH',
      path: '/api/tenants/:tenant',
      summary: 'Change a tenant’s redaction policy or audit retention',
      body: tenantSettingsSchema,
      response: tenantSchema,
    },
    ({ who, params, body }) =>
      guarded(who, 'tenant.settings', tenantOf(params), () =>
        deps.tenants.updateSettings(tenantOf(params), body),
      ),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'PUT',
      path: '/api/tenants/:tenant/quotas',
      summary: 'Replace a tenant’s quotas',
      body: quotasSchema,
      response: tenantSchema,
    },
    ({ who, params, body }) =>
      guarded(who, 'tenant.quotas', tenantOf(params), () =>
        deps.tenants.setQuotas(tenantOf(params), body),
      ),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'GET',
      path: '/api/tenants/:tenant/policies',
      summary: 'A tenant’s policy rows',
      response: policiesSchema,
    },
    ({ who, params }) =>
      guarded(who, 'policies.manage', tenantOf(params), async () => {
        const rows = await deps.tenants.policies(tenantOf(params));
        return rows.ok ? ok({ policies: [...rows.value] }) : rows;
      }),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'PUT',
      path: '/api/tenants/:tenant/policies',
      summary: 'Replace a tenant’s policy rows',
      body: policiesSchema,
      response: policiesSchema,
    },
    ({ who, params, body }) =>
      guarded(who, 'policies.manage', tenantOf(params), async () => {
        const rows = await deps.tenants.setPolicies(tenantOf(params), body);
        return rows.ok ? ok({ policies: [...rows.value] }) : rows;
      }),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'GET',
      path: '/api/tenants/:tenant/keys',
      summary: 'A tenant’s API keys, without their secrets',
      response: z.object({ keys: z.array(keyInfo) }),
    },
    ({ who, params }) =>
      guarded(who, 'keys.manage', tenantOf(params), async () => {
        if (!deps.apiKeys) return noKeys();
        const listed = await deps.apiKeys.list(tenantOf(params));
        return listed.ok ? ok({ keys: listed.value }) : listed;
      }),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'POST',
      path: '/api/tenants/:tenant/keys',
      summary: 'Create an API key in a tenant; the secret is returned once',
      body: tenantKeyInput,
      response: keyInfo.extend({ key: z.string() }),
    },
    ({ who, params, body }) =>
      guarded(who, 'keys.manage', tenantOf(params), () =>
        deps.apiKeys
          ? deps.apiKeys.create({ ...body, tenant: tenantOf(params) })
          : Promise.resolve(noKeys()),
      ),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'DELETE',
      path: '/api/tenants/:tenant/keys/:id',
      summary: 'Revoke one of a tenant’s API keys',
    },
    ({ who, params }) =>
      guarded(who, 'keys.manage', tenantOf(params), async () => {
        if (!deps.apiKeys) return noKeys();
        const revoked = await deps.apiKeys.revoke(params.id ?? '', tenantOf(params));
        if (!revoked.ok) return revoked;
        return revoked.value ? ok(undefined) : err(mindlogError('NOT_FOUND', 'no such API key'));
      }),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'GET',
      path: '/api/tenants/:tenant/members',
      summary: 'A tenant’s dashboard accounts',
      response: z.object({ members: z.array(superuserSchema) }),
    },
    ({ who, params }) =>
      guarded(who, 'members.manage', tenantOf(params), async () => {
        const listed = await deps.admin.members(tenantOf(params));
        return listed.ok ? ok({ members: listed.value }) : listed;
      }),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'PUT',
      path: '/api/tenants/:tenant/members',
      summary: 'Create a dashboard account in a tenant, or reset its password and role',
      body: memberInputSchema,
      response: superuserSchema,
    },
    ({ who, params, body }) =>
      guarded(who, 'members.manage', tenantOf(params), () =>
        deps.admin.upsertMember(tenantOf(params), body),
      ),
  );
  defineRoute(
    app,
    routes,
    {
      ...common,
      method: 'DELETE',
      path: '/api/tenants/:tenant/members/:email',
      summary: 'Delete one of a tenant’s dashboard accounts',
    },
    ({ who, params }) =>
      guarded(who, 'members.manage', tenantOf(params), async () => {
        const removed = await deps.admin.removeMember(tenantOf(params), params.email ?? '');
        if (!removed.ok) return removed;
        return removed.value ? ok(undefined) : err(mindlogError('NOT_FOUND', 'no such account'));
      }),
  );
}
