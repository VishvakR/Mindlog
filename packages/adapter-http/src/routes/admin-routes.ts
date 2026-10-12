import type { FastifyInstance } from 'fastify';
import { ok } from '@mindlog/core';
import { z } from 'zod';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const anyObject = z.record(z.string(), z.unknown());

/** Node overview and read-only settings for the dashboard. */
export function adminRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/admin/overview',
      summary: 'Node status for the overview page',
      tag: 'admin',
      response: anyObject,
    },
    async () => ok(await deps.overview()),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/admin/settings',
      summary: 'Effective configuration, secrets redacted',
      tag: 'admin',
      response: anyObject,
    },
    () => Promise.resolve(ok(deps.settings())),
  );
}
