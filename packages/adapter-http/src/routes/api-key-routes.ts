import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { err, mindlogError, ok } from '@mindlog/core';
import { apiKeyInputSchema } from '@mindlog/services';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const keyInfo = z.object({
  id: z.string(),
  tenant: z.string(),
  user: z.string().optional(),
  name: z.string(),
  created: z.string(),
});

/** API keys for agents over MCP (PLAN 15.2), managed by superusers. */
export function apiKeyRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  const keys = deps.apiKeys;
  const missing = () =>
    err(mindlogError('UNIMPLEMENTED', 'API keys are not available on this node'));
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/admin/api-keys',
      summary: 'API keys, without their secrets',
      tag: 'admin',
      response: z.object({ keys: z.array(keyInfo) }),
    },
    async () => {
      if (!keys) return missing();
      const listed = await keys.list();
      return listed.ok ? ok({ keys: listed.value }) : listed;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/admin/api-keys',
      summary: 'Create an API key for a tenant (optionally one user); the secret is returned once',
      tag: 'admin',
      body: apiKeyInputSchema,
      response: keyInfo.extend({ key: z.string() }),
    },
    ({ body }) => (keys ? keys.create(body) : Promise.resolve(missing())),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'DELETE',
      path: '/api/admin/api-keys/:id',
      summary: 'Revoke an API key',
      tag: 'admin',
    },
    async ({ params }) => {
      if (!keys) return missing();
      const revoked = await keys.revoke(params.id ?? '');
      if (!revoked.ok) return revoked;
      return revoked.value ? ok(undefined) : err(mindlogError('NOT_FOUND', 'no such API key'));
    },
  );
}
