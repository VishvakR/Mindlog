import type { FastifyInstance } from 'fastify';
import { ok } from '@mindlog/core';
import { z } from 'zod';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const anyObject = z.record(z.string(), z.unknown());

const logEntry = z.object({
  atMs: z.number(),
  level: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.unknown()),
});

/** Node overview, read-only settings and recent logs for the dashboard. */
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
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/admin/logs',
      summary: 'The latest log entries on this node, newest first, secrets removed',
      tag: 'admin',
      response: z.object({ entries: z.array(logEntry) }),
    },
    () => Promise.resolve(ok({ entries: [...(deps.recentLogs?.(200) ?? [])] })),
  );
}
