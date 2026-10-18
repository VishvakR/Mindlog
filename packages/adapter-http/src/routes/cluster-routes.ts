import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clusterActionSchema } from '@mindlog/services';
import type { HttpServerDeps } from '../http-deps.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const anyObject = z.record(z.string(), z.unknown());

/** The Cluster page: PD's view of nodes, ranges and operators, and operator actions. */
export function clusterRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/cluster/overview',
      summary: 'Nodes, ranges, running and recent operators',
      tag: 'cluster',
      response: anyObject,
    },
    () => deps.cluster.overview(),
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/cluster/actions',
      summary: 'Drain or remove a node, transfer a leader, split a range',
      tag: 'cluster',
      body: clusterActionSchema,
      response: z.object({ message: z.string() }),
    },
    ({ body }) => deps.cluster.act(body),
  );
}
