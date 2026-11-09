import type { FastifyInstance } from 'fastify';
import { err, mindlogError, ok } from '@mindlog/core';
import { authResultSchema, authWithPasswordBodySchema, superuserSchema } from '@mindlog/services';
import { z } from 'zod';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

/** Superuser login (PocketBase-shaped `auth-with-password`) and session checks. */
export function superuserRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/superusers/auth-with-password',
      summary: 'Log in as a superuser; returns a bearer token',
      tag: 'superusers',
      auth: false,
      body: authWithPasswordBodySchema,
      response: authResultSchema,
    },
    ({ body }) => deps.admin.authWithPassword(body.email, body.password),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/superusers/exists',
      summary: 'Whether any superuser exists (the login page shows setup help otherwise)',
      tag: 'superusers',
      auth: false,
      response: z.object({ exists: z.boolean() }),
    },
    async () => {
      const exists = await deps.admin.hasSuperusers();
      return exists.ok ? ok({ exists: exists.value }) : exists;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/superusers/me',
      summary: 'The authenticated account (a superuser or a tenant member)',
      tag: 'superusers',
      auth: 'identity',
      response: superuserSchema,
    },
    ({ request }) =>
      request.headers.authorization
        ? deps.admin.verifyToken(request.headers.authorization.replace(/^Bearer /, ''))
        : Promise.resolve(err(mindlogError('UNAUTHENTICATED', 'Missing or invalid auth token.'))),
  );
}
