import type { FastifyInstance } from 'fastify';
import { err, mindlogError, ok } from '@mindlog/core';
import { z } from 'zod';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const status = z.object({ status: z.string() });

/** Liveness, readiness and the Prometheus scrape endpoint. */
export function healthRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/health',
      summary: 'Liveness',
      tag: 'health',
      auth: false,
      response: status,
    },
    () => Promise.resolve(ok({ status: 'ok' })),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/ready',
      summary: 'Readiness: recovered and listening',
      tag: 'health',
      auth: false,
      response: status,
    },
    () =>
      Promise.resolve(
        deps.ready()
          ? ok({ status: 'ready' })
          : err(mindlogError('UNAVAILABLE', 'The node is starting or stopping.')),
      ),
  );
  // Left open for scraping, like Prometheus exporters (phase-2.md lists this).
  app.get('/metrics', { config: { auth: false } }, async (_request, reply) =>
    reply.type(deps.prometheus.contentType).send(await deps.prometheus.render()),
  );
}
