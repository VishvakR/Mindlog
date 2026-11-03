import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { err, mindlogError, ok } from '@mindlog/core';
import type { CollectionInput } from '@mindlog/collections';
import type { HttpServerDeps } from '../http-deps.js';
import { contextOf } from '../identity.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const info = z.object({ schema: z.record(z.string(), z.unknown()), version: z.string() });
const schemaBody = z.record(z.string(), z.unknown());
const missing = () =>
  err(mindlogError('UNIMPLEMENTED', 'collections are not available on this node'));

/** Collection schemas (PLAN 16.1), superusers only; tenant from `X-Mindlog-Tenant`. */
export function collectionsRoutes(
  app: FastifyInstance,
  routes: AnyRouteSpec[],
  deps: HttpServerDeps,
): void {
  const c = deps.collections;
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/collections',
      summary: 'Every collection schema of the tenant',
      tag: 'collections',
      auth: false,
      response: z.object({ items: z.array(info) }),
    },
    async ({ request }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      const listed = await c.listCollections(ctx.value);
      return listed.ok ? ok({ items: listed.value }) : listed;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/collections',
      summary: 'Create a collection',
      tag: 'collections',
      auth: false,
      body: schemaBody,
      response: info,
    },
    async ({ request, body }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      return ctx.ok ? c.saveCollection(ctx.value, body as CollectionInput) : ctx;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/collections/rules/check',
      summary: 'Check a rule and suggest completions at a cursor (rule editor)',
      tag: 'collections',
      auth: false,
      body: z.object({
        collection: z.string(),
        rule: z.string().max(4096),
        cursor: z.number().int().min(0).optional(),
        draft: z.record(z.string(), z.unknown()).optional(),
      }),
      response: z.object({ issues: z.array(z.unknown()), completions: z.unknown().optional() }),
    },
    async ({ request, body }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      const { draft, cursor, ...rest } = body;
      return c.checkRuleText(ctx.value, {
        ...rest,
        ...(cursor === undefined ? {} : { cursor }),
        ...(draft ? { draft: draft as CollectionInput } : {}),
      });
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/collections/:name',
      summary: 'One collection schema',
      tag: 'collections',
      auth: false,
      response: info,
    },
    async ({ request, params }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      return ctx.ok ? c.getCollection(ctx.value, params['name'] ?? '') : ctx;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PATCH',
      path: '/api/collections/:name',
      summary: 'Replace a collection schema; `version` must be the one read',
      tag: 'collections',
      auth: false,
      body: z.object({ schema: schemaBody, version: z.string().regex(/^\d+$/) }),
      response: info,
    },
    async ({ request, params, body }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      if (body.schema['name'] !== params['name'])
        return err(mindlogError('INVALID_ARGUMENT', 'a collection keeps its name'));
      return c.saveCollection(ctx.value, body.schema as CollectionInput, body.version);
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'DELETE',
      path: '/api/collections/:name',
      summary: 'Delete a collection and its records',
      tag: 'collections',
      auth: false,
    },
    async ({ request, params }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      return ctx.ok ? c.deleteCollection(ctx.value, params['name'] ?? '') : ctx;
    },
  );
}
