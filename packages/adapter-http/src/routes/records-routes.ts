import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { err, mindlogError, ok } from '@mindlog/core';
import type { HttpServerDeps } from '../http-deps.js';
import { contextOf } from '../identity.js';
import type { AnyRouteSpec } from '../route.js';
import { defineRoute } from '../route.js';

const record = z.record(z.string(), z.unknown());
const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  perPage: z.coerce.number().int().min(1).max(500).optional(),
  filter: z.string().max(4096).optional(),
  sort: z.string().max(512).optional(),
  expand: z.string().max(512).optional(),
  fields: z.string().max(512).optional(),
  skipTotal: z
    .enum(['true', 'false', '1', '0'])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});
const viewQuery = listQuery.pick({ expand: true, fields: true });
const missing = () =>
  err(mindlogError('UNIMPLEMENTED', 'collections are not available on this node'));
/** Drops absent query fields (exactOptionalPropertyTypes). */
const stripUndefined = <T extends object>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

/** Records (PLAN 16, PocketBase-shaped paths); every call is checked against the collection rules. */
export function recordsRoutes(
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
      path: '/api/collections/:collection/records',
      summary: 'List records the list rule lets the requester see',
      tag: 'records',
      auth: false,
      query: listQuery,
      response: z.object({
        page: z.number(),
        perPage: z.number(),
        totalItems: z.number(),
        totalPages: z.number(),
        items: z.array(record),
      }),
    },
    async ({ request, params, query }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      return ctx.ok ? c.list(ctx.value, params['collection'] ?? '', stripUndefined(query)) : ctx;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'GET',
      path: '/api/collections/:collection/records/:id',
      summary: 'One record, if the view rule allows it',
      tag: 'records',
      auth: false,
      query: viewQuery,
      response: record,
    },
    async ({ request, params, query }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      return ctx.ok
        ? c.view(ctx.value, params['collection'] ?? '', params['id'] ?? '', stripUndefined(query))
        : ctx;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'POST',
      path: '/api/collections/:collection/records',
      summary: 'Create a record (signup, for auth collections)',
      tag: 'records',
      auth: false,
      body: record,
      response: record,
    },
    async ({ request, params, body }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      const made = await c.create(ctx.value, params['collection'] ?? '', body);
      return made.ok ? ok(made.value.record) : made;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'PATCH',
      path: '/api/collections/:collection/records/:id',
      summary: 'Update a record; `field+`, `+field` and `field-` modify numbers and lists',
      tag: 'records',
      auth: false,
      body: record,
      response: record,
    },
    async ({ request, params, body }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      const updated = await c.update(
        ctx.value,
        params['collection'] ?? '',
        params['id'] ?? '',
        body,
      );
      return updated.ok ? ok(updated.value.record) : updated;
    },
  );
  defineRoute(
    app,
    routes,
    {
      method: 'DELETE',
      path: '/api/collections/:collection/records/:id',
      summary: 'Delete a record',
      tag: 'records',
      auth: false,
    },
    async ({ request, params }) => {
      if (!c) return missing();
      const ctx = await contextOf(request, deps);
      if (!ctx.ok) return ctx;
      const deleted = await c.delete(ctx.value, params['collection'] ?? '', params['id'] ?? '');
      return deleted.ok ? ok(undefined) : deleted;
    },
  );
}
